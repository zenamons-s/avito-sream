import { Controller, Get, Post } from '@nestjs/common';
import * as fs from 'fs';
import * as path from 'path';
import { AvitoWatcherService } from './avito.watcher.service';
import { EventBus } from './event-bus';

type BindState = { url: string; boundAt: string };

const messengerUrlRe = /avito\.ru\/(profile\/)?messenger(\/|\?|$)/i;
const messengerChannelUrlRe = /avito\.ru\/(profile\/)?messenger\/channel\//i;

@Controller('bind')
export class BindController {
  private readonly bindFilePath = path.join(process.cwd(), '.avito-target.json');

  constructor(
    private readonly watcher: AvitoWatcherService,
    private readonly bus: EventBus,
  ) {}

  @Get('status')
  status() {
    const state = this.read();
    if (!state?.url || !messengerUrlRe.test(state.url)) {
      this.emitStatus('warn', 'Bind status: not bound');
      return { ok: false };
    }

    this.emitStatus('info', `Bind status: ${state.url}`);
    return { ok: true, url: state.url };
  }

  /**
   * Binds current Puppeteer page URL as the target chat.
   * Use flow: run with HEADLESS=false, login, open the desired chat manually, then POST /bind/current.
   */
  @Post('current')
  async bindCurrent() {
    const initialUrl = ((await this.watcher.getBestBindableUrl()) ?? '').trim();
    const debugUrls = await this.watcher.debugListPages();
    this.emitStatus('info', `Bind debug pages: ${debugUrls.join(' | ')}`);
    if (!initialUrl) {
      const message = 'No active Puppeteer page URL (is browser running?)';
      this.emitStatus('warn', message);
      return { ok: false, message, debugUrls };
    }

    if (!messengerUrlRe.test(initialUrl)) {
      const message = `Current URL does not look like Avito messenger: ${initialUrl}`;
      this.emitStatus('warn', message);
      return { ok: false, message, url: initialUrl, debugUrls };
    }

    let finalUrl = initialUrl;
    let warning: string | undefined;
    if (!messengerChannelUrlRe.test(initialUrl)) {
      const ensured = await this.watcher.ensureChannelUrl();
      if (ensured?.url) {
        finalUrl = ensured.url;
      }
      if (!ensured?.channel) {
        warning = 'Bound messenger search page, not channel';
      }
    }

    const state: BindState = { url: finalUrl, boundAt: new Date().toISOString() };
    fs.writeFileSync(this.bindFilePath, JSON.stringify(state, null, 2), 'utf-8');

    const okMessage = `Target chat bound: ${finalUrl}`;
    if (warning) {
      this.emitStatus('warn', `${okMessage}. ${warning}`);
    } else {
      this.emitStatus('info', okMessage);
    }
    return warning ? { ok: true, url: finalUrl, warning } : { ok: true, url: finalUrl };
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

  private emitStatus(level: 'info' | 'warn' | 'error', message: string) {
    this.bus.emit({
      type: 'status',
      level,
      message,
      at: new Date().toISOString(),
    });
  }
}
