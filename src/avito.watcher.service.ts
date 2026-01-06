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
  private supportChatDetected = false;

  // Persistently bound chat URL (optional, created via /bind/current)
  private readonly bindFilePath = path.join(process.cwd(), '.avito-target.json');

  constructor(private readonly bus: EventBus) {}

  async onModuleInit() {
    if (process.env.NODE_ENV === 'test') {
      this.bus.emit({
        type: 'status',
        level: 'info',
        message: 'Avito watcher skipped in test environment.',
        at: new Date().toISOString(),
      });
      return;
    }

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
        const ready = await this.openTargetChat();
        if (ready) {
          await this.watchLoop();
        }
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
    this.installPopupHandlers(this.page);
    this.browser.on('targetcreated', async (target) => {
      if (target.type() !== 'page') return;
      try {
        const createdPage = await target.page();
        if (!createdPage) return;
        this.installPopupHandlers(createdPage);
        await this.maybeAdoptMessengerPage(createdPage, 'targetcreated');
      } catch {}
    });
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
    const login = (process.env.AVITO_LOGIN ?? '').trim();
    const password = (process.env.AVITO_PASSWORD ?? '').trim();
    const hasCredentials = login.length > 0 && password.length > 0;

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

        if (!hasCredentials) {
          this.bus.emit({
            type: 'status',
            level: 'info',
            message: 'Auth via cookies/manual (AVITO_LOGIN/AVITO_PASSWORD not set).',
            at: new Date().toISOString(),
          });
        } else {
          this.bus.emit({
            type: 'status',
            level: 'info',
            message: 'Attempting auto-login via form with AVITO_LOGIN/AVITO_PASSWORD.',
            at: new Date().toISOString(),
          });

          const filled = await this.tryFillLoginForm(login, password);
          if (!filled) {
            this.bus.emit({
              type: 'status',
              level: 'warn',
              message: 'Login form not detected. Falling back to manual/cookie auth.',
              at: new Date().toISOString(),
            });
          } else {
            await this.submitLoginForm();
            const twoFaTimeout = Number(process.env.AVITO_2FA_TIMEOUT_MS ?? 120000);
            this.bus.emit({
              type: 'status',
              level: 'info',
              message: `Waiting for 2FA confirmation (timeout ${Math.round(twoFaTimeout / 1000)}s)…`,
              at: new Date().toISOString(),
            });

            const authed = await this.waitForAuthCompletion(twoFaTimeout);
            if (!authed) {
              this.bus.emit({
                type: 'status',
                level: 'warn',
                message: '2FA confirmation timeout. Complete confirmation or use cookies.',
                at: new Date().toISOString(),
              });
            }
          }
        }

        if (headlessEnv && page.url().includes('login')) {
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
   * 1) Если есть bound chat URL — открываем его.
   */
  private async openTargetChat(): Promise<boolean> {
    const page = this.mustPage();
    const direct = (process.env.TARGET_CHAT_URL ?? '').trim();
    let lastAttemptUrl: string | null = null;

    await page.waitForSelector('body', { timeout: 60000 });
    await sleep(1000);

    while (!this.stopping) {
      const candidate = await this.resolveTargetChatUrl(direct);

      if (!candidate) {
        if (!this.supportChatDetected) {
          this.bus.emit({
            type: 'status',
            level: 'warn',
            message: 'Not bound. Open target chat and press Bind.',
            at: new Date().toISOString(),
          });
        } else {
          this.bus.emit({
            type: 'status',
            level: 'warn',
            message: 'Waiting for target bind after support chat detection.',
            at: new Date().toISOString(),
          });
        }
        await sleep(3000);
        continue;
      }

      if (lastAttemptUrl !== candidate || !this.supportChatDetected) {
        await this.openChatUrl(candidate);
        lastAttemptUrl = candidate;
      }
      const ok = await this.verifyNotSupportChat();
      if (ok) {
        return true;
      }

      this.supportChatDetected = true;
      await sleep(3000);
    }

    return false;
  }

  isMessengerUrl(url: string | null): boolean {
    return /avito\.ru\/(profile\/)?messenger(\/|\?|$)/i.test(url ?? '');
  }

  isMessengerChannelUrl(url: string | null): boolean {
    return /\/messenger\/channel\//i.test(url ?? '');
  }

  private setActivePage(page: Page, reason: string) {
    this.page = page;
    const url = page.url();
    if (url) {
      this.lastMessengerUrl = url;
    }
    this.bus.emit({
      type: 'status',
      level: 'info',
      message: `Switched active page (${reason}): ${url}`,
      at: new Date().toISOString(),
    });
  }

  /** Returns current Puppeteer page URL (for /bind/current). */
  getCurrentUrl(): string | null {
    try {
      const url = this.page?.url?.() ?? null;
      if (url && this.isMessengerUrl(url)) return url;
      if (this.lastMessengerUrl && this.isMessengerUrl(this.lastMessengerUrl)) {
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
        if (this.isMessengerUrl(url)) {
          this.setActivePage(p, 'messenger-tab');
          return url;
        }
      }
    } catch {}

    return null;
  }

  getActiveUrl(): string | null {
    try {
      return this.page?.url?.() ?? null;
    } catch {
      return null;
    }
  }

  async getBestBindableUrl(): Promise<string | null> {
    try {
      if (this.browser) {
        const pages = await this.browser.pages();
        const channel = pages.find((p) => this.isMessengerChannelUrl(p.url()));
        if (channel) {
          this.setActivePage(channel, 'best-bind-channel');
          return channel.url();
        }

        const messenger = pages.find((p) => this.isMessengerUrl(p.url()));
        if (messenger) {
          this.setActivePage(messenger, 'best-bind-messenger');
          return messenger.url();
        }
      }
    } catch {}

    return this.page?.url?.() ?? this.getCurrentUrl();
  }

  async debugListPages(): Promise<string[]> {
    try {
      if (!this.browser) return [];
      const pages = await this.browser.pages();
      return pages.map((p) => p.url());
    } catch {
      return [];
    }
  }

  /**
   * Ensures the active tab points to a messenger channel URL.
   * Returns the resolved URL and whether it is a channel URL.
   */
  async ensureChannelUrl(): Promise<{ url: string | null; channel: boolean }> {
    const page = this.mustPage();
    const current = page.url();
    if (!this.isMessengerUrl(current)) {
      return { url: current, channel: false };
    }
    if (this.isMessengerChannelUrl(current)) {
      return { url: current, channel: true };
    }

    const target = (process.env.TARGET_CONTACT ?? 'Рушан').trim();

    this.bus.emit({
      type: 'status',
      level: 'info',
      message: `Attempting to resolve messenger channel for: ${target}`,
      at: new Date().toISOString(),
    });

    let clicked = await this.clickDropdownResultByTarget(target);
    if (!clicked) {
      clicked = await this.clickFirstDialog();
    }

    if (clicked) {
      await this.waitForChannelUrl().catch(() => undefined);
    }

    const url = page.url();
    return { url, channel: this.isMessengerChannelUrl(url) };
  }

  private installPopupHandlers(page: Page) {
    page.on('popup', async (popup) => {
      if (!popup) return;
      this.page = popup;
      this.installPopupHandlers(popup);
      await this.maybeAdoptMessengerPage(popup, 'popup');
    });
    page.on('framenavigated', async (frame) => {
      if (frame !== page.mainFrame()) return;
      await this.maybeAdoptMessengerPage(page, 'navigate');
    });
  }

  private async maybeAdoptMessengerPage(page: Page, reason: string) {
    try {
      const url = page.url();
      if (this.isMessengerChannelUrl(url) || this.isMessengerUrl(url)) {
        this.setActivePage(page, reason);
      }
    } catch {}
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
    if (!this.isMessengerUrl(url)) return;

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
      if (!this.isMessengerChannelUrl(u)) return null;
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

  private async clickDropdownResultByTarget(target: string): Promise<boolean> {
    const page = this.mustPage();
    const clicked = await page.evaluate((name) => {
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

      options.sort((a, b) => (a.el.innerText?.length ?? 0) - (b.el.innerText?.length ?? 0));
      let el: HTMLElement | null = options[0].el;

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

    if (clicked) {
      await sleep(900);
    }
    return clicked;
  }

  private async clickFirstDialog(): Promise<boolean> {
    const page = this.mustPage();
    const clicked = await page.evaluate(() => {
      const sidebar =
        (document.querySelector('aside') as HTMLElement | null) ||
        (document.querySelector('nav') as HTMLElement | null) ||
        (document.querySelector('[role="navigation"]') as HTMLElement | null) ||
        document.body;

      const isVisible = (el: HTMLElement) => {
        const rect = el.getBoundingClientRect();
        return rect.width > 2 && rect.height > 2;
      };

      const isClickable = (x: HTMLElement) =>
        x.tagName === 'A' ||
        x.tagName === 'BUTTON' ||
        x.getAttribute('role') === 'button' ||
        x.getAttribute('role') === 'link' ||
        typeof (x as any).onclick === 'function' ||
        getComputedStyle(x).cursor === 'pointer';

      const links = Array.from(sidebar.querySelectorAll<HTMLAnchorElement>('a[href]'))
        .filter((el) => isVisible(el))
        .filter((el) => el.href.includes('/messenger/channel/'));

      let el: HTMLElement | null = links[0] ?? null;

      if (!el) {
        const candidates = Array.from(
          sidebar.querySelectorAll<HTMLElement>('a, button, [role="button"], [role="link"], div, span'),
        ).filter((node) => isVisible(node));

        for (const node of candidates) {
          let cur: HTMLElement | null = node;
          for (let i = 0; i < 6 && cur; i++) {
            if (isClickable(cur)) {
              el = cur;
              break;
            }
            cur = cur.parentElement as HTMLElement | null;
          }
          if (el) break;
        }
      }

      if (!el) return false;

      el.scrollIntoView({ block: 'center' });
      el.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
      el.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
      el.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      return true;
    });

    if (clicked) {
      await sleep(900);
    }
    return clicked;
  }

  private async waitForChannelUrl() {
    const page = this.mustPage();
    await page.waitForFunction(
      () => window.location.pathname.includes('/messenger/channel/'),
      { timeout: 15000 },
    );
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
        norm(
          el.getAttribute('aria-label') ||
            el.getAttribute('title') ||
            el.textContent ||
            el.innerText ||
            '',
        );

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

  private async resolveTargetChatUrl(direct: string): Promise<string | null> {
    if (direct) {
      const url = direct.startsWith('http') ? direct : `https://www.avito.ru${direct}`;
      return url;
    }

    const bound = this.readBoundChatUrl();
    if (bound) return bound;

    return null;
  }

  private async openChatUrl(url: string) {
    const page = this.mustPage();
    this.supportChatDetected = false;
    this.bus.emit({
      type: 'status',
      level: 'info',
      message: `Opening chat URL: ${url}`,
      at: new Date().toISOString(),
    });

    await page.goto(url, { waitUntil: 'domcontentloaded' });
    await sleep(1200);
    await this.waitForChatLikelyOpened();
    this.lastMessengerUrl = page.url();
    this.maybePersistBoundChatUrl(this.lastMessengerUrl, 'target-chat-url');
  }

  private async verifyNotSupportChat(): Promise<boolean> {
    const page = this.mustPage();
    const url = page.url();
    const title = await this.getChatTitle();
    const normalized = title.toLowerCase();
    const supportHits = ['поддержка', 'служба поддержки', 'avito', 'авито'];
    const supportDetected = supportHits.some((word) => normalized.includes(word));

    if (!title) {
      this.bus.emit({
        type: 'status',
        level: 'warn',
        message: `Chat title not found for URL: ${url}`,
        at: new Date().toISOString(),
      });
      return true;
    }

    this.bus.emit({
      type: 'status',
      level: 'info',
      message: `Chat title detected: "${title}" (url: ${url})`,
      at: new Date().toISOString(),
    });

    if (supportDetected) {
      this.bus.emit({
        type: 'status',
        level: 'warn',
        message: 'Support chat detected. Open target chat and Bind.',
        at: new Date().toISOString(),
      });
      return false;
    }

    return true;
  }

  private async getChatTitle(): Promise<string> {
    const page = this.mustPage();
    const title = await page.evaluate(() => {
      const norm = (s: string) => (s || '').replace(/\s+/g, ' ').trim();
      const selectors = [
        'header h1',
        'header h2',
        'main header h1',
        'main header h2',
        '[data-marker*="chat-title"]',
        '[class*="title"]',
        '[class*="header"] h1',
        '[class*="header"] h2',
      ];

      for (const sel of selectors) {
        const el = document.querySelector(sel) as HTMLElement | null;
        if (!el) continue;
        const text = norm(el.innerText || el.textContent || '');
        if (text) return text;
      }
      return '';
    });

    return String(title || '').trim();
  }

  private async tryFillLoginForm(login: string, password: string): Promise<boolean> {
    const page = this.mustPage();

    const loginInput =
      (await page.$(
        'input[type="tel"], input[type="email"], input[name*="login" i], input[name*="phone" i], input[autocomplete="username"]',
      )) ?? null;
    const passwordInput =
      (await page.$('input[type="password"], input[autocomplete="current-password"]')) ?? null;

    if (!loginInput || !passwordInput) return false;

    await loginInput.click({ clickCount: 3 }).catch(() => undefined);
    await page.keyboard.down(process.platform === 'darwin' ? 'Meta' : 'Control');
    await page.keyboard.press('KeyA');
    await page.keyboard.up(process.platform === 'darwin' ? 'Meta' : 'Control');
    await page.keyboard.type(login, { delay: 40 });

    await passwordInput.click({ clickCount: 3 }).catch(() => undefined);
    await page.keyboard.down(process.platform === 'darwin' ? 'Meta' : 'Control');
    await page.keyboard.press('KeyA');
    await page.keyboard.up(process.platform === 'darwin' ? 'Meta' : 'Control');
    await page.keyboard.type(password, { delay: 40 });

    return true;
  }

  private async submitLoginForm() {
    const page = this.mustPage();
    const clicked = await page.evaluate(() => {
      const isVisible = (el: HTMLElement) => {
        const rect = el.getBoundingClientRect();
        return rect.width > 0 && rect.height > 0;
      };
      const text = (el: HTMLElement) => (el.innerText || el.textContent || '').trim().toLowerCase();
      const looksLikeSubmit = (el: HTMLElement) =>
        ['войти', 'вход', 'login', 'sign in', 'продолжить', 'continue'].some((t) => text(el).includes(t));

      const candidates = Array.from(
        document.querySelectorAll<HTMLElement>('button[type="submit"], input[type="submit"], button, a, div'),
      ).filter((el) => isVisible(el) && looksLikeSubmit(el));

      const target = candidates[0];
      if (!target) return false;

      target.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
      target.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
      target.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      return true;
    });

    if (!clicked) {
      await page.keyboard.press('Enter').catch(() => undefined);
    }
  }

  private async waitForAuthCompletion(timeoutMs: number): Promise<boolean> {
    const page = this.mustPage();
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      await sleep(1000);
      if (!page.url().includes('login')) return true;
    }
    return !page.url().includes('login');
  }

  private async watchLoop() {
    const page = this.mustPage();

    if (this.supportChatDetected) {
      this.bus.emit({
        type: 'status',
        level: 'warn',
        message: 'Watcher paused: support chat detected. Open target chat and Bind.',
        at: new Date().toISOString(),
      });
      return;
    }

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
      if ((window as any).__avitoObserverInstalled) return true;

      const norm = (s: string) => (s || '').replace(/\s+/g, ' ').trim();
      const messageSelectors = [
        '[data-marker*="message"]',
        '[data-marker*="msg"]',
        '[role="listitem"]',
        'article',
        '[class*="message"]',
        '[class*="bubble"]',
      ].join(', ');

      const isInsideNav = (el: HTMLElement | null) =>
        !!el?.closest('nav, aside, header, [role="navigation"]');

      const isUiNoise = (text: string) => {
        const t = norm(text).toLowerCase();
        if (!t) return true;

        const exactNoise = new Set([
          'уведомления',
          'кошелек',
          'кошелёк',
          'платные услуги',
          'мои резюме',
          'избранное',
          'объявления',
          'профиль',
          'настройки',
          'помощь',
          'перейти в помощь',
          'поддержка',
          'поддержка авито',
          'служба поддержки',
          'партнерская программа',
          'услуги',
          'доставка',
          'звонки',
        ]);

        if (exactNoise.has(t)) return true;
        if (/^сегодня$|^вчера$/.test(t)) return true;
        if (/^(понедельник|вторник|среда|четверг|пятница|суббота|воскресенье)$/.test(t)) return true;

        const dateRe =
          /^(понедельник|вторник|среда|четверг|пятница|суббота|воскресенье),?\s+\d{1,2}\s+(января|февраля|марта|апреля|мая|июня|июля|августа|сентября|октября|ноября|декабря)$/i;

        if (dateRe.test(t)) return true;
        if (/войти|регистрация/i.test(t)) return true;

        return false;
      };

      const extractMessageText = (el: HTMLElement) => {
        const raw = el.innerText || el.textContent || '';
        const lines = raw.split('\n').map(norm).filter(Boolean);
        return lines.length ? lines[lines.length - 1] : norm(raw);
      };

      const countMessages = (root: HTMLElement) =>
        Array.from(root.querySelectorAll<HTMLElement>(messageSelectors)).filter((node) => {
          if (isInsideNav(node)) return false;
          const text = extractMessageText(node);
          return text.length > 0 && text.length < 4000 && !isUiNoise(text);
        }).length;

      const findMessageContainer = (): HTMLElement | null => {
        const containers: Map<HTMLElement, number> = new Map();
        const nodes = Array.from(document.querySelectorAll<HTMLElement>(messageSelectors)).filter(
          (node) => !isInsideNav(node),
        );

        for (const node of nodes) {
          let cur: HTMLElement | null = node;
          for (let i = 0; i < 6 && cur; i++) {
            if (!cur || cur.tagName === 'BODY' || cur.tagName === 'HTML' || cur.tagName === 'MAIN') break;
            if (!isInsideNav(cur)) {
              containers.set(cur, (containers.get(cur) ?? 0) + 1);
            }
            cur = cur.parentElement;
          }
        }

        let best: { el: HTMLElement; count: number } | null = null;
        for (const [el, count] of containers.entries()) {
          if (!best || count > best.count) best = { el, count };
        }

        if (!best || best.count < 2) return null;
        return best.el;
      };

      const container = findMessageContainer();
      if (!container) return false;

      // чтобы не спамить одним и тем же
      const seen = new Set<string>();
      const startTs = Date.now();
      const graceMs = 1500;

      const handleNode = (node: Node) => {
        if (!(node instanceof HTMLElement)) return;
        if (Date.now() - startTs < graceMs) return;
        if (isInsideNav(node)) return;

        const messageNodes: HTMLElement[] = [];
        if (node.matches?.(messageSelectors)) messageNodes.push(node);
        messageNodes.push(...Array.from(node.querySelectorAll<HTMLElement>(messageSelectors)));

        for (const msgNode of messageNodes) {
          if (isInsideNav(msgNode)) continue;
          const msgText = extractMessageText(msgNode);
          if (!msgText || msgText.length > 4000) continue;
          if (isUiNoise(msgText)) continue;

          if (seen.has(msgText)) continue;
          seen.add(msgText);
          if (seen.size > 200) {
            const arr = Array.from(seen);
            seen.clear();
            for (const x of arr.slice(-80)) seen.add(x);
          }

          // @ts-ignore
          window.__emitAvitoMessage({ from: targetName, text: msgText, at: new Date().toISOString() });
        }
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
      const messageSelectors = [
        '[data-marker*="message"]',
        '[data-marker*="msg"]',
        '[role="listitem"]',
        'article',
        '[class*="message"]',
        '[class*="bubble"]',
      ].join(', ');

      const isInsideNav = (el: HTMLElement | null) =>
        !!el?.closest('nav, aside, header, [role="navigation"]');

      const isUiNoise = (text: string) => {
        const t = norm(text).toLowerCase();
        if (!t) return true;

        const exactNoise = new Set([
          'уведомления',
          'кошелек',
          'кошелёк',
          'платные услуги',
          'мои резюме',
          'избранное',
          'объявления',
          'профиль',
          'настройки',
          'помощь',
          'перейти в помощь',
          'поддержка',
          'поддержка авито',
          'служба поддержки',
          'партнерская программа',
          'услуги',
          'доставка',
          'звонки',
        ]);

        if (exactNoise.has(t)) return true;
        if (/^сегодня$|^вчера$/.test(t)) return true;
        if (/^(понедельник|вторник|среда|четверг|пятница|суббота|воскресенье)$/.test(t)) return true;

        const dateRe =
          /^(понедельник|вторник|среда|четверг|пятница|суббота|воскресенье),?\s+\d{1,2}\s+(января|февраля|марта|апреля|мая|июня|июля|августа|сентября|октября|ноября|декабря)$/i;

        if (dateRe.test(t)) return true;
        if (/войти|регистрация/i.test(t)) return true;

        return false;
      };

      const extractMessageText = (el: HTMLElement) => {
        const raw = el.innerText || el.textContent || '';
        const lines = raw.split('\n').map(norm).filter(Boolean);
        return lines.length ? lines[lines.length - 1] : norm(raw);
      };

      const countMessages = (root: HTMLElement) =>
        Array.from(root.querySelectorAll<HTMLElement>(messageSelectors)).filter((node) => {
          if (isInsideNav(node)) return false;
          const text = extractMessageText(node);
          return text.length > 0 && text.length < 4000 && !isUiNoise(text);
        }).length;

      const findMessageContainer = (): HTMLElement | null => {
        const containers: Map<HTMLElement, number> = new Map();
        const nodes = Array.from(document.querySelectorAll<HTMLElement>(messageSelectors)).filter(
          (node) => !isInsideNav(node),
        );

        for (const node of nodes) {
          let cur: HTMLElement | null = node;
          for (let i = 0; i < 6 && cur; i++) {
            if (!cur || cur.tagName === 'BODY' || cur.tagName === 'HTML' || cur.tagName === 'MAIN') break;
            if (!isInsideNav(cur)) {
              containers.set(cur, (containers.get(cur) ?? 0) + 1);
            }
            cur = cur.parentElement;
          }
        }

        let best: { el: HTMLElement; count: number } | null = null;
        for (const [el, count] of containers.entries()) {
          if (!best || count > best.count) best = { el, count };
        }

        if (!best || best.count < 2) return null;
        return best.el;
      };

      const container = findMessageContainer();
      if (!container) return '';

      const candidates = Array.from(container.querySelectorAll<HTMLElement>(messageSelectors));
      for (let i = candidates.length - 1; i >= 0; i -= 1) {
        const node = candidates[i];
        if (isInsideNav(node)) continue;
        const text = extractMessageText(node);
        if (!text || text.length > 4000) continue;
        if (isUiNoise(text)) continue;
        return text;
      }

      return '';
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
