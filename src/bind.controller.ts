import { Controller, Get, Post } from '@nestjs/common';
import * as fs from 'fs';
import * as path from 'path';
import { AvitoWatcherService } from './avito.watcher.service';
import { EventBus } from './event-bus';

type BindState = { url: string; boundAt: string };

type BindKind = 'channel' | 'search' | 'messenger' | 'other' | 'none';

type BindResult = {
  ok: boolean;
  kind: BindKind;
  url?: string;
  message?: string;
};

const messengerUrlRe = /avito\.ru\/(profile\/)?messenger(\/|\?|$)/i;
const messengerChannelUrlRe = /avito\.ru\/(profile\/)?messenger\/channel\//i;
const messengerChannelPathRe = /\/profile\/messenger\/channel\//i;
const messengerSearchRe = /\/profile\/messenger(\/|\?|$)/i;
const messengerSearchQueryRe = /[?&]q=/i;

@Controller('bind')
export class BindController {
  private readonly bindFilePath = path.join(process.cwd(), '.avito-target.json');

  constructor(
    private readonly watcher: AvitoWatcherService,
    private readonly bus: EventBus,
  ) {}

  @Get('status')
  status(): BindResult {
    const state = this.read();
    if (!state?.url) {
      this.emitStatus('warn', 'Bind status: not bound');
      return { ok: false, kind: 'none' };
    }

    const normalizedUrl = this.normalizeUrl(state.url);
    const classification = this.classifyUrl(normalizedUrl);
    if (classification.kind !== 'channel') {
      this.emitStatus('warn', `Bind status: invalid url (${classification.kind})`);
      return {
        ok: false,
        kind: classification.kind,
        url: normalizedUrl,
        message: 'Bound URL is not channel',
      };
    }

    this.emitStatus('info', `Bind status: ${normalizedUrl}`);
    return { ok: true, kind: 'channel', url: normalizedUrl };
  }

  /**
   * Binds current Puppeteer page URL as the target chat.
   * Use flow: run with HEADLESS=false, login, open the desired chat manually, then POST /bind/current.
   */
  @Post('current')
  async bindCurrent(): Promise<BindResult & { debugUrls?: string[] }> {
    const initialUrl = (this.watcher.getCurrentUrl() ?? '').trim();
    let candidateUrl = initialUrl;

    if (!this.isChannelUrl(candidateUrl)) {
      const messengerTabUrl = await this.watcher.getMessengerTabUrl();
      if (messengerTabUrl) {
        candidateUrl = messengerTabUrl.trim();
      }
    }

    const debugUrls = await this.watcher.debugListPages();
    this.emitStatus('info', `Bind debug pages: ${debugUrls.join(' | ')}`);

    if (!candidateUrl) {
      const message = 'No active Puppeteer page URL (is browser running?)';
      this.emitStatus('warn', message);
      return { ok: false, kind: 'other', message, debugUrls };
    }

    const normalizedUrl = this.normalizeUrl(candidateUrl);
    const classification = this.classifyUrl(normalizedUrl);
    if (classification.kind !== 'channel') {
      const message = 'Not a channel URL. Open a chat and try again.';
      this.emitStatus('warn', `${message} (${classification.kind}): ${normalizedUrl}`);
      return {
        ok: false,
        kind: classification.kind,
        message,
        url: normalizedUrl,
        debugUrls,
      };
    }

    const state: BindState = { url: normalizedUrl, boundAt: new Date().toISOString() };
    fs.writeFileSync(this.bindFilePath, JSON.stringify(state, null, 2), 'utf-8');

    const okMessage = `Target chat bound: ${normalizedUrl}`;
    this.emitStatus('info', okMessage);
    return { ok: true, kind: 'channel', url: normalizedUrl };
  }

  @Post('clear')
  clear() {
    try {
      if (fs.existsSync(this.bindFilePath)) {
        fs.unlinkSync(this.bindFilePath);
      }
      this.emitStatus('info', 'Target chat binding cleared');
    } catch (error) {
      const message = `Failed to clear binding: ${error instanceof Error ? error.message : String(error)}`;
      this.emitStatus('error', message);
    }

    return { ok: true };
  }

  private read(): BindState | null {
    try {
      if (!fs.existsSync(this.bindFilePath)) return null;
      const raw = fs.readFileSync(this.bindFilePath, 'utf-8');
      const j = JSON.parse(raw);
      const url = String(j?.url ?? '').trim();
      const boundAt = String(j?.boundAt ?? '').trim();
      if (!url) return null;
      return { url, boundAt: boundAt || new Date(0).toISOString() };
    } catch {
      return null;
    }
  }

  private normalizeUrl(raw: string): string {
    const trimmed = raw.trim();
    if (!trimmed) return trimmed;
    if (trimmed.startsWith('/')) {
      return `https://www.avito.ru${trimmed}`;
    }
    return trimmed;
  }

  private isChannelUrl(url: string): boolean {
    return messengerChannelUrlRe.test(url) || messengerChannelPathRe.test(url);
  }

  private classifyUrl(url: string): { kind: BindKind } {
    if (this.isChannelUrl(url)) {
      return { kind: 'channel' };
    }
    const isMessenger = messengerUrlRe.test(url) || messengerSearchRe.test(url);
    if (isMessenger) {
      if (messengerSearchQueryRe.test(url)) {
        return { kind: 'search' };
      }
      return { kind: 'messenger' };
    }
    return { kind: 'other' };
  }

  private emitStatus(level: 'info' | 'warn' | 'error', message: string) {
    this.bus.emit({
      type: 'status',
      level,
      message,
      at: new Date().toISOString(),
    });
  }
}
