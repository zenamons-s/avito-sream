import { Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import puppeteer, { Browser, Page } from 'puppeteer';
import { EventBus } from './event-bus';
import * as fs from 'fs';
import * as path from 'path';

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

type LastMsg = { from: string; text: string; at: string };

@Injectable()
export class AvitoWatcherService implements OnModuleInit, OnModuleDestroy {
  private browser?: Browser;
  private page?: Page;
  private stopping = false;

  private lastFingerprint = '';
  private bridgeInstalled = false;
  private lastMessengerUrl: string | null = null;

  // Persistently bound chat URL (optional, created via /bind/current)
  private readonly bindFilePath = path.join(process.cwd(), '.avito-target.json');

  constructor(private readonly bus: EventBus) {}

  async onModuleInit() {
    this.bus.emit({
      type: 'status',
      level: 'info',
      message: 'Avito watcher starting…',
      at: new Date().toISOString(),
    });

    this.runLoop().catch((e) => {
      this.bus.emit({
        type: 'status',
        level: 'error',
        message: `Watcher fatal: ${String(e)}`,
        at: new Date().toISOString(),
      });
    });
  }

  async onModuleDestroy() {
    this.stopping = true;
    await this.safeClose();
  }

  private async runLoop() {
    while (!this.stopping) {
      try {
        await this.startBrowser();
        await this.openMessengerWithAuth();
        await this.openTargetChat();
        await this.watchLoop();
      } catch (e: any) {
        await this.dumpDebugArtifacts('error');
        this.bus.emit({
          type: 'status',
          level: 'error',
          message: `Watcher error → restart: ${e?.message ?? String(e)}`,
          at: new Date().toISOString(),
        });
        await this.safeClose();
        await sleep(2500);
      }
    }
  }

  private async startBrowser() {
    const headlessEnv = String(process.env.HEADLESS ?? 'false') === 'true';
    const headlessMode: any = headlessEnv ? 'new' : false;
    const navTimeout = Number(process.env.NAV_TIMEOUT_MS ?? 60000);

    const executablePath =
      process.env.PUPPETEER_EXECUTABLE_PATH && process.env.PUPPETEER_EXECUTABLE_PATH.trim().length > 0
        ? process.env.PUPPETEER_EXECUTABLE_PATH
        : puppeteer.executablePath();

    this.browser = await puppeteer.launch({
      headless: headlessMode,
      userDataDir: '.avito-profile',
      executablePath,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-blink-features=AutomationControlled',
        '--lang=ru-RU,ru',
        '--window-size=1280,800',
      ],
    });

    this.page = await this.browser.newPage();
    await this.maybeLoadCookies(this.page);
    this.page.setDefaultNavigationTimeout(navTimeout);

    await this.page.setViewport({ width: 1280, height: 800 });
    await this.page.setUserAgent(
      'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/143.0.0.0 Safari/537.36',
    );

    this.bus.emit({
      type: 'status',
      level: 'info',
      message: `Browser started (headless=${headlessEnv ? 'new' : 'false'})`,
      at: new Date().toISOString(),
    });
  }

  private async openMessengerWithAuth() {
    const page = this.mustPage();

    const candidates = [
      'https://www.avito.ru/profile/messenger',
      'https://www.avito.ru/messenger',
    ];

    for (const url of candidates) {
      const resp = await page.goto(url, { waitUntil: 'domcontentloaded' });
      await sleep(1200);

      // В некоторых версиях это SPA — даём догрузиться
      try {
        const anyPage = page as any;
        if (typeof anyPage.waitForNetworkIdle === 'function') {
          await anyPage.waitForNetworkIdle({ idleTime: 800, timeout: 15000 });
        }
      } catch {}

      const status = resp?.status() ?? 0;

      const is404 = await page.evaluate(() => {
        const t = document.body?.innerText || '';
        return t.includes('Такой страницы') || t.includes('не существует') || t.includes('Ошибка 404');
      });

      if (status === 404 || is404) {
        this.bus.emit({
          type: 'status',
          level: 'warn',
          message: `Messenger URL returned 404: ${url}`,
          at: new Date().toISOString(),
        });
        continue;
      }

      if (page.url().includes('login')) {
        const headlessEnv = String(process.env.HEADLESS ?? 'false') === 'true';

        if (headlessEnv) {
          this.bus.emit({
            type: 'status',
            level: 'error',
            message:
              'AUTH_REQUIRED (headless). Provide cookies via AVITO_COOKIES_* or run once with HEADLESS=false to login.',
            at: new Date().toISOString(),
          });
          throw new Error('Not logged in in headless. Provide cookies or run once with HEADLESS=false to refresh session.');
        }

        this.bus.emit({
          type: 'status',
          level: 'warn',
          message: 'Нужен логин. Введите данные/смс в окне браузера (HEADLESS=false).',
          at: new Date().toISOString(),
        });

        const deadline = Date.now() + 5 * 60_000;
        while (Date.now() < deadline) {
          await sleep(1500);
          if (!page.url().includes('login')) break;
        }
        if (page.url().includes('login')) throw new Error('Login timeout (manual auth not completed)');
      }

      this.bus.emit({
        type: 'status',
        level: 'info',
        message: `Messenger opened: ${page.url()}`,
        at: new Date().toISOString(),
      });
      this.lastMessengerUrl = page.url();
      this.maybePersistBoundChatUrl(this.lastMessengerUrl, 'messenger-open');
      return;
    }

    throw new Error('Cannot open Avito messenger: all candidate URLs look like 404');
  }

  /**
   * Открыть чат с нужным контактом.
   *
   * Стратегии по приоритету:
   * 0) Если задан TARGET_CHAT_URL — открываем сразу.
   * 1) Поиск по чатам (если есть input).
   * 2) Сниффер XHR/JSON: вытаскиваем URL канала из ответов.
   * 3) Scan+scroll: ищем по тексту в левой панели.
   */
  private async openTargetChat() {
    const page = this.mustPage();
    const target = (process.env.TARGET_CONTACT ?? 'Рушан').trim();
    const direct = (process.env.TARGET_CHAT_URL ?? '').trim();

    this.bus.emit({
      type: 'status',
      level: 'info',
      message: `Opening target chat: ${target}`,
      at: new Date().toISOString(),
    });

    await page.waitForSelector('body', { timeout: 60000 });
    await sleep(1000);

    if (direct) {
      const url = direct.startsWith('http') ? direct : `https://www.avito.ru${direct}`;
      this.bus.emit({ type: 'status', level: 'info', message: `Using TARGET_CHAT_URL: ${url}`, at: new Date().toISOString() });
      await page.goto(url, { waitUntil: 'domcontentloaded' });
      await sleep(1200);
      await this.waitForChatLikelyOpened();
      this.lastMessengerUrl = page.url();
      this.maybePersistBoundChatUrl(this.lastMessengerUrl, 'target-chat-url');
      return;
    }

    // 0.5) If chat was bound earlier (manual open + /bind/current) — open it directly
    const bound = this.readBoundChatUrl();
    if (bound) {
      this.bus.emit({
        type: 'status',
        level: 'info',
        message: `Using bound chat URL: ${bound}`,
        at: new Date().toISOString(),
      });
      await page.goto(bound, { waitUntil: 'domcontentloaded' });
      await sleep(1200);
      await this.waitForChatLikelyOpened();
      this.lastMessengerUrl = page.url();
      this.maybePersistBoundChatUrl(this.lastMessengerUrl, 'bound-chat-url');
      return;
    }

    // 1) Поиск в UI
    const searchInput = await this.findSearchInput();
    if (searchInput) {
      this.bus.emit({ type: 'status', level: 'info', message: 'Search input found — trying search', at: new Date().toISOString() });

      await searchInput.click({ clickCount: 3 });
      await page.keyboard.down(process.platform === 'darwin' ? 'Meta' : 'Control');
      await page.keyboard.press('KeyA');
      await page.keyboard.up(process.platform === 'darwin' ? 'Meta' : 'Control');
      await page.keyboard.type(target, { delay: 60 });
      // Многие UI показывают результаты только после Enter
      await sleep(500);
      await page.keyboard.press('Enter').catch(() => undefined);
      await sleep(900);

      const clicked = await this.clickSearchResultOrChat(target);
      if (clicked) {
        await this.waitForChatLikelyOpened();
        this.bus.emit({ type: 'status', level: 'info', message: `Chat opened via search: ${target}`, at: new Date().toISOString() });
        this.lastMessengerUrl = page.url();
        this.maybePersistBoundChatUrl(this.lastMessengerUrl, 'search');
        return;
      }

      this.bus.emit({ type: 'status', level: 'warn', message: 'Search input exists, but no clickable result found — fallback', at: new Date().toISOString() });
    } else {
      this.bus.emit({ type: 'status', level: 'info', message: 'Search input not found — trying network sniff', at: new Date().toISOString() });
    }

    // 2) Сниффер XHR/JSON для получения URL канала
    const chanUrl = await this.findChannelUrlViaNetwork(target, 20000);
    if (chanUrl) {
      this.bus.emit({ type: 'status', level: 'info', message: `Channel URL found via network: ${chanUrl}`, at: new Date().toISOString() });
      await page.goto(chanUrl, { waitUntil: 'domcontentloaded' });
      await sleep(1200);
      await this.waitForChatLikelyOpened();
      this.lastMessengerUrl = page.url();
      this.maybePersistBoundChatUrl(this.lastMessengerUrl, 'network-sniff');
      return;
    }

    // 3) Scan+scroll
    this.bus.emit({ type: 'status', level: 'info', message: 'Fallback scan+scroll in sidebar…', at: new Date().toISOString() });

    const maxSteps = Number(process.env.CHAT_SCAN_STEPS ?? 60);
    for (let step = 0; step < maxSteps; step++) {
      const clicked = await this.clickChatByText(target);
      if (clicked) {
        await this.waitForChatLikelyOpened();
        this.bus.emit({ type: 'status', level: 'info', message: `Chat opened via scan+scroll: ${target}`, at: new Date().toISOString() });
        this.lastMessengerUrl = page.url();
        this.maybePersistBoundChatUrl(this.lastMessengerUrl, 'scan-scroll');
        return;
      }

      const scrolled = await page.evaluate(() => {
        const root =
          (document.querySelector('aside') as HTMLElement | null) ||
          (document.querySelector('nav') as HTMLElement | null) ||
          (document.querySelector('[role="navigation"]') as HTMLElement | null) ||
          document.body;

        const isScrollable = (el: HTMLElement) =>
          el.scrollHeight > el.clientHeight && ['auto', 'scroll'].includes(getComputedStyle(el).overflowY);

        const all = [root, ...Array.from(root.querySelectorAll<HTMLElement>('*'))];
        const sc = all.find(isScrollable);

        if (sc) {
          sc.scrollTop += Math.floor(sc.clientHeight * 0.9);
          return true;
        }

        window.scrollBy(0, Math.floor(window.innerHeight * 0.8));
        return true;
      });

      if (!scrolled) break;
      await sleep(650);
    }

    throw new Error(`Chat not found after scan+scroll: ${target}`);
  }

  /** Returns current Puppeteer page URL (for /bind/current). */
  getCurrentUrl(): string | null {
    try {
      const url = this.page?.url?.() ?? null;
      if (url && /avito\.ru\/(profile\/)?messenger\//i.test(url)) return url;
      if (this.lastMessengerUrl && /avito\.ru\/(profile\/)?messenger\//i.test(this.lastMessengerUrl)) {
        return this.lastMessengerUrl;
      }
    } catch {}
    return null;
  }

  /** Finds any open Puppeteer tab that looks like Avito messenger. */
  async getMessengerTabUrl(): Promise<string | null> {
    try {
      if (!this.browser) return null;
      const pages = await this.browser.pages();
      for (const p of pages) {
        const url = p.url();
        if (/avito\.ru\/(profile\/)?messenger\//i.test(url)) {
          this.page = p;
          this.lastMessengerUrl = url;
          return url;
        }
      }
    } catch {}

    return null;
  }

  private async maybeLoadCookies(page: Page) {
    const jsonRaw = process.env.AVITO_COOKIES_JSON ?? '';
    const b64Raw = process.env.AVITO_COOKIES_B64 ?? '';
    const pathRaw = process.env.AVITO_COOKIES_PATH ?? '';

    let payload = jsonRaw.trim();
    if (!payload && b64Raw.trim()) {
      try {
        payload = Buffer.from(b64Raw.trim(), 'base64').toString('utf-8');
      } catch {
        payload = '';
      }
    }

    if (!payload && pathRaw.trim()) {
      try {
        payload = fs.readFileSync(pathRaw.trim(), 'utf-8');
      } catch {
        payload = '';
      }
    }

    if (!payload) return;

    try {
      const cookies = JSON.parse(payload);
      if (!Array.isArray(cookies) || cookies.length === 0) return;
      await page.setCookie(...cookies);
      this.bus.emit({
        type: 'status',
        level: 'info',
        message: `Loaded ${cookies.length} auth cookies`,
        at: new Date().toISOString(),
      });
    } catch (e: any) {
      this.bus.emit({
        type: 'status',
        level: 'warn',
        message: `Failed to load cookies: ${e?.message ?? String(e)}`,
        at: new Date().toISOString(),
      });
    }
  }

  private maybePersistBoundChatUrl(url: string | null, reason: string) {
    if (!url) return;
    const autoBind = String(process.env.AUTO_BIND_ON_OPEN ?? 'false') === 'true';
    if (!autoBind) return;
    if (!/avito\.ru\/(profile\/)?messenger\//i.test(url)) return;

    try {
      const state = { url, boundAt: new Date().toISOString(), reason };
      fs.writeFileSync(this.bindFilePath, JSON.stringify(state, null, 2), 'utf-8');
      this.bus.emit({
        type: 'status',
        level: 'info',
        message: `Auto-bound chat: ${url}`,
        at: new Date().toISOString(),
      });
    } catch {}
  }

  private readBoundChatUrl(): string | null {
    try {
      if (!fs.existsSync(this.bindFilePath)) return null;
      const raw = fs.readFileSync(this.bindFilePath, 'utf-8');
      const j = JSON.parse(raw);
      const u = String(j?.url ?? '').trim();
      if (!u) return null;
      // keep it strict: only messenger chat URLs
      if (!/avito\.ru\/(profile\/)?messenger\//i.test(u)) return null;
      return u;
    } catch {
      return null;
    }
  }

  private async findSearchInput() {
    const page = this.mustPage();
    const handles = await page.$$('input');
    for (const h of handles) {
      try {
        const meta = await h.evaluate((el) => ({
          type: (el as HTMLInputElement).type || '',
          placeholder: el.getAttribute('placeholder') || '',
          aria: el.getAttribute('aria-label') || '',
          name: el.getAttribute('name') || '',
        }));

        const text = `${meta.placeholder} ${meta.aria} ${meta.name}`.toLowerCase();
        const looksLikeSearch = text.includes('поиск') || text.includes('найти') || text.includes('search');
        const rightType = meta.type === 'text' || meta.type === 'search' || meta.type === '';

        if (looksLikeSearch && rightType) return h;
      } catch {}
    }
    return null;
  }

  /**
   * Clicks a chat result from the search dropdown (listbox/option) if present;
   * otherwise falls back to scanning the sidebar.
   */
  private async clickSearchResultOrChat(target: string): Promise<boolean> {
    const page = this.mustPage();

    const clickedFromDropdown = await page.evaluate((name) => {
      const norm = (s: string) => (s || '').replace(/\s+/g, ' ').trim().toLowerCase();
      const target = norm(name);

      const getText = (el: HTMLElement) =>
        norm(
          el.getAttribute('aria-label') ||
            el.getAttribute('title') ||
            el.textContent ||
            el.innerText ||
            '',
        );

      const isClickable = (x: HTMLElement) =>
        x.tagName === 'A' ||
        x.tagName === 'BUTTON' ||
        x.getAttribute('role') === 'button' ||
        x.getAttribute('role') === 'option' ||
        x.getAttribute('role') === 'link' ||
        x.tabIndex >= 0 ||
        typeof (x as any).onclick === 'function' ||
        getComputedStyle(x).cursor === 'pointer';

      const dropdown =
        (document.querySelector('[role="listbox"]') as HTMLElement | null) ||
        (document.querySelector('[data-marker*="suggest"]') as HTMLElement | null) ||
        (document.querySelector('[data-marker*="dropdown"]') as HTMLElement | null);

      if (!dropdown) return false;

      const options = Array.from(
        dropdown.querySelectorAll<HTMLElement>('[role="option"], [role="link"], a, button, div, span'),
      )
        .map((el) => ({ el, text: getText(el) }))
        .filter((x) => x.text.includes(target));

      if (options.length === 0) return false;

      // Usually the most specific (shortest) text is the correct row.
      options.sort((a, b) => (a.el.innerText?.length ?? 0) - (b.el.innerText?.length ?? 0));
      let el: HTMLElement | null = options[0].el;

      // bubble up to a clickable container
      let cur: HTMLElement | null = el;
      for (let i = 0; i < 10 && cur; i++) {
        if (isClickable(cur)) {
          el = cur;
          break;
        }
        cur = cur.parentElement as HTMLElement | null;
      }
      if (!el) return false;

      if (!isClickable(el) && el.closest) {
        const clickable = el.closest('a, button, [role="button"], [role="option"], [role="link"]') as HTMLElement | null;
        if (clickable) el = clickable;
      }

      el.scrollIntoView({ block: 'center' });
      el.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
      el.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
      el.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      return true;
    }, target);

    if (clickedFromDropdown) {
      await sleep(900);
      return true;
    }

    return this.clickChatByText(target);
  }

  private async findChannelUrlViaNetwork(targetName: string, timeoutMs: number): Promise<string | null> {
    const page = this.mustPage();
    const target = targetName.toLowerCase();

    const hits: { url: string; body: string }[] = [];

    const handler = async (res: any) => {
      try {
        const headers = res.headers?.() ?? {};
        const ct = String(headers['content-type'] ?? headers['Content-Type'] ?? '').toLowerCase();
        if (!ct.includes('application/json')) return;

        const url: string = res.url?.() ?? '';
        // Сильно не фильтруем — Avito меняет пути
        if (!/messenger|chat|channel|dialog|conversation/i.test(url)) return;

        const data = await res.json().catch(() => null);
        if (!data) return;

        const body = JSON.stringify(data);
        if (!body.toLowerCase().includes(target)) return;

        hits.push({ url, body });
      } catch {}
    };

    page.on('response', handler);

    const started = Date.now();
    while (Date.now() - started < timeoutMs) {
      await sleep(250);
      if (hits.length > 0) break;
    }

    page.off('response', handler);

    if (hits.length === 0) return null;

    // Ищем URL канала рядом с target в JSON
    for (const h of hits) {
      const s = h.body;
      const lower = s.toLowerCase();
      const idx = lower.indexOf(target);
      const window = s.slice(Math.max(0, idx - 1500), Math.min(s.length, idx + 1500));

      // ищем куски похожие на /profile/messenger/channel/...
      const reChan = /\/profile\/messenger\/channel\/[^"\\]+/g;
      const m1 = window.match(reChan);
      if (m1 && m1[0]) return `https://www.avito.ru${m1[0].replace(/\\/g, '')}`;

      // иногда URL может быть в виде "channelUrl":"..."
      const reUrl = /https?:\/\/www\.avito\.ru\/profile\/messenger\/channel\/[^"\\]+/g;
      const m2 = window.match(reUrl);
      if (m2 && m2[0]) return m2[0].replace(/\\/g, '');

      // если структуры другие — сохраним в debug, чтобы можно было быстро подогнать
      await this.writeDebugJson('dialogs-hit', { sourceUrl: h.url, sample: JSON.parse(s) });
      break;
    }

    return null;
  }

  private async writeDebugJson(tag: string, obj: any) {
    try {
      const dir = path.join(process.cwd(), 'debug');
      fs.mkdirSync(dir, { recursive: true });
      const ts = new Date().toISOString().replace(/[:.]/g, '-');
      fs.writeFileSync(path.join(dir, `${ts}.${tag}.json`), JSON.stringify(obj, null, 2), 'utf-8');
    } catch {}
  }

  private async clickChatByText(target: string): Promise<boolean> {
    const page = this.mustPage();

    const point = await page.evaluate((name) => {
      const norm = (s: string) => s.replace(/\s+/g, ' ').trim().toLowerCase();
      const target = norm(name);

      const sidebar =
        (document.querySelector('aside') as HTMLElement | null) ||
        (document.querySelector('nav') as HTMLElement | null) ||
        (document.querySelector('[role="navigation"]') as HTMLElement | null) ||
        document.body;

      const getText = (el: HTMLElement) =>
        norm(el.innerText || el.getAttribute('aria-label') || el.getAttribute('title') || el.textContent || '');

      const nodes = Array.from(
        sidebar.querySelectorAll<HTMLElement>('a, button, [role="button"], [role="link"], div, span'),
      ).filter((el) => {
        const t = getText(el);
        return t.includes(target) && t.length > 0 && t.length < 500;
      });

      if (nodes.length === 0) return null;

      nodes.sort((a, b) => (getText(a).length ?? 0) - (getText(b).length ?? 0));
      let el: HTMLElement | null = nodes[0];

      const isClickable = (x: HTMLElement) =>
        x.tagName === 'A' ||
        x.tagName === 'BUTTON' ||
        x.getAttribute('role') === 'button' ||
        x.getAttribute('role') === 'link' ||
        typeof (x as any).onclick === 'function' ||
        getComputedStyle(x).cursor === 'pointer';

      let cur: HTMLElement | null = el;
      for (let i = 0; i < 8 && cur; i++) {
        if (isClickable(cur)) {
          el = cur;
          break;
        }
        cur = cur.parentElement as HTMLElement | null;
      }

      if (!el) return null;

      el.scrollIntoView({ block: 'center' });
      const rect = el.getBoundingClientRect();
      if (rect.width < 5 || rect.height < 5) return null;

      return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
    }, target);

    if (!point) return false;

    await page.mouse.click(point.x, point.y);
    await sleep(850);
    return true;
  }

  private async waitForChatLikelyOpened() {
    const page = this.mustPage();
    await page
      .waitForFunction(
        () =>
          !!document.querySelector('textarea') ||
          !!document.querySelector('[contenteditable="true"]') ||
          !!document.querySelector('form'),
        { timeout: 15000 },
      )
      .catch(() => undefined);
  }

  private async watchLoop() {
    const page = this.mustPage();

    this.bus.emit({
      type: 'status',
      level: 'info',
      message: 'Watching new messages…',
      at: new Date().toISOString(),
    });

    await this.captureLastMessageAsBaseline();

    // Попытка realtime (MutationObserver)
    const installed = await this.installRealtimeObserver().catch(() => false);
    if (installed) {
      this.bus.emit({
        type: 'status',
        level: 'info',
        message: 'Realtime observer installed ✅',
        at: new Date().toISOString(),
      });

      while (!this.stopping) {
        if (page.url().includes('login')) throw new Error('Session expired (redirected to login)');
        await sleep(1000);
      }
      return;
    }

    // Fallback: polling
    const pollInterval = Number(process.env.POLL_INTERVAL_MS ?? 1500);
    this.bus.emit({
      type: 'status',
      level: 'warn',
      message: 'Realtime observer unavailable — fallback to polling',
      at: new Date().toISOString(),
    });

    while (!this.stopping) {
      if (page.url().includes('login')) throw new Error('Session expired (redirected to login)');

      const msg = await this.readLastMessage();
      if (msg) {
        const fp = `${msg.from}|${msg.text}`.trim();
        if (fp && fp !== this.lastFingerprint) {
          this.lastFingerprint = fp;
          this.bus.emit({ type: 'message', ...msg });
        }
      }
      await sleep(pollInterval);
    }
  }

  private async installRealtimeObserver(): Promise<boolean> {
    const page = this.mustPage();

    if (!this.bridgeInstalled) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await page.exposeFunction('__emitAvitoMessage', (payload: any) => {
        const from = String(payload?.from ?? process.env.TARGET_CONTACT ?? 'unknown');
        const text = String(payload?.text ?? '');
        if (!text) return;

        const at = payload?.at ? String(payload.at) : new Date().toISOString();
        const fp = `${from}|${text}`.trim();
        if (!fp || fp === this.lastFingerprint) return;

        this.lastFingerprint = fp;
        this.bus.emit({ type: 'message', from, text, at });
      });

      this.bridgeInstalled = true;
    }

    const target = (process.env.TARGET_CONTACT ?? 'Рушан').trim();

    const ok = await page.evaluate((targetName) => {
      const norm = (s: string) => (s || '').replace(/\s+/g, ' ').trim();

      // пытаемся взять контейнер сообщений
      const pickContainer = (): HTMLElement | null => {
        const roleLog = document.querySelector('[role="log"]') as HTMLElement | null;
        if (roleLog) return roleLog;

        const input = document.querySelector('textarea, [contenteditable="true"]') as HTMLElement | null;
        const main = (input?.closest('main') as HTMLElement | null) || (document.querySelector('main') as HTMLElement | null);
        return main || (document.body as HTMLElement);
      };

      const container = pickContainer();
      if (!container) return false;

      const isNoise = (t: string) =>
        /войти|регистрация|профиль|настройки|объявления|избранное/i.test(t);

      // чтобы не спамить одним и тем же
      const seen = new Set<string>();

      const handleNode = (node: Node) => {
        if (!(node instanceof HTMLElement)) return;

        const text = norm(node.innerText || '');
        if (!text || text.length < 1 || text.length > 4000) return;
        if (isNoise(text)) return;

        // иногда прилетает сразу большая пачка — берём последнюю "логичную" строку
        const lines = text.split('\n').map(norm).filter(Boolean);
        const msgText = lines.length ? lines[lines.length - 1] : text;

        const key = msgText;
        if (seen.has(key)) return;
        seen.add(key);
        if (seen.size > 200) {
          // чистим
          const arr = Array.from(seen);
          seen.clear();
          for (const x of arr.slice(-80)) seen.add(x);
        }

        // @ts-ignore
        window.__emitAvitoMessage({ from: targetName, text: msgText, at: new Date().toISOString() });
      };

      const obs = new MutationObserver((mutations) => {
        for (const m of mutations) {
          for (const n of Array.from(m.addedNodes)) handleNode(n);
        }
      });

      obs.observe(container, { childList: true, subtree: true });

      // пометим чтобы не ставить второй раз
      (window as any).__avitoObserverInstalled = true;
      return true;
    }, target);

    return Boolean(ok);
  }

  private async captureLastMessageAsBaseline() {
    const msg = await this.readLastMessage();
    if (!msg) return;
    this.lastFingerprint = `${msg.from}|${msg.text}`.trim();

    this.bus.emit({
      type: 'status',
      level: 'info',
      message: 'Baseline set (existing messages ignored)',
      at: new Date().toISOString(),
    });
  }

  private async readLastMessage(): Promise<LastMsg | null> {
    const page = this.mustPage();
    const from = (process.env.TARGET_CONTACT ?? 'Рушан').trim();

    const text = await page.evaluate(() => {
      const norm = (s: string) => (s || '').replace(/\s+/g, ' ').trim();
      const roleLog = document.querySelector('[role="log"]') as HTMLElement | null;

      const container =
        roleLog ||
        (document.querySelector('main') as HTMLElement | null) ||
        (document.body as HTMLElement);

      const candidates = Array.from(container.querySelectorAll<HTMLElement>('div, p, span'))
        .map((n) => norm(n.innerText))
        .filter((t) => t && t.length > 0 && t.length < 5000);

      // отсекаем явно UI-шум
      const cleaned = candidates.filter((t) => !/войти|регистрация|профиль|настройки|объявления|избранное/i.test(t));

      return cleaned[cleaned.length - 1] ?? '';
    });

    if (!text) return null;
    return { from, text, at: new Date().toISOString() };
  }

  private mustPage(): Page {
    if (!this.page) throw new Error('Page not initialized');
    return this.page;
  }

  private async safeClose() {
    try {
      await this.page?.close().catch(() => undefined);
    } finally {
      this.page = undefined;
    }
    try {
      await this.browser?.close().catch(() => undefined);
    } finally {
      this.browser = undefined;
    }
  }

  private async dumpDebugArtifacts(tag: string) {
    try {
      const page = this.page;
      if (!page) return;

      const dir = path.join(process.cwd(), 'debug');
      fs.mkdirSync(dir, { recursive: true });

      const ts = new Date().toISOString().replace(/[:.]/g, '-');
      const pngPath = path.join(dir, `${ts}.${tag}.png`);
      const htmlPath = path.join(dir, `${ts}.${tag}.html`);

      await page.screenshot({ path: pngPath, fullPage: true }).catch(() => undefined);
      const html = await page.content().catch(() => '');
      if (html) fs.writeFileSync(htmlPath, html, 'utf-8');

      this.bus.emit({
        type: 'status',
        level: 'warn',
        message: `Debug saved: ${path.relative(process.cwd(), pngPath)} (and .html)`,
        at: new Date().toISOString(),
      });
    } catch {}
  }
}
