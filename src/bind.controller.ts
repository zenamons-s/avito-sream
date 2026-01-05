import { Body, Controller, Get, Post } from '@nestjs/common';
import * as fs from 'fs';
import * as path from 'path';
import { AvitoWatcherService } from './avito.watcher.service';
import { EventBus } from './event-bus';

type BindState = { url: string; boundAt: string };

const messengerUrlRe = /avito\.ru\/(profile\/)?messenger(\/|$)/i;

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
    const ok = Boolean(state?.url);
    this.bus.emit({
      type: 'status',
      level: ok ? 'info' : 'warn',
      message: ok ? `Bind status: ${state?.url}` : 'Bind status: not bound',
      at: new Date().toISOString(),
    });
    if (!ok) {
      return { ok: false, bound: false };
    }
    return {
      ok: true,
      bound: true,
    return {
      ok: true,
      bound: true,
      return { ok: false };
    }
    return {
      ok: true,
      url: state?.url ?? null,
    };
  }

  /**
   * Binds current Puppeteer page URL as the target chat.
   * Use flow: run with HEADLESS=false, login, open the desired chat manually, then POST /bind/current.
   */
  @Post('current')
  async bindCurrent(@Body() _body: any) {
    const finalUrl = ((await this.watcher.getBestBindableUrl()) ?? '').trim();
    if (!finalUrl) {
      const message = 'No active Puppeteer page URL (is browser running?)';
      this.bus.emit({
        type: 'status',
        level: 'warn',
        message,
        at: new Date().toISOString(),
      });
      return { ok: false, message };
    }
    if (!messengerUrlRe.test(finalUrl)) {
      const message = `Current URL does not look like Avito messenger: ${finalUrl}`;
      this.bus.emit({
        type: 'status',
        level: 'warn',
        message,
        at: new Date().toISOString(),
      });
      return { ok: false, message, url: finalUrl };
    }

    const state: BindState = { url: finalUrl, boundAt: new Date().toISOString() };
    fs.writeFileSync(this.bindFilePath, JSON.stringify(state, null, 2), 'utf-8');

    this.bus.emit({
      type: 'status',
      level: 'info',
      message: `Target chat bound: ${finalUrl}`,
      at: new Date().toISOString(),
    });

    return { ok: true, url: finalUrl, bound: true, boundAt: state.boundAt, message: 'Chat bound' };
    return { ok: true, url: finalUrl, bound: true };
    return { ok: true, url: finalUrl };
  }

  @Post('clear')
  clear() {
    try {
      if (fs.existsSync(this.bindFilePath)) fs.unlinkSync(this.bindFilePath);
    } catch {}

    this.bus.emit({
      type: 'status',
      level: 'warn',
      message: 'Target chat binding cleared',
      at: new Date().toISOString(),
    });

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
      return { url, boundAt: boundAt || null } as BindState;
    } catch {
      return null;
    }
  }
}
