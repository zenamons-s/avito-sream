import { Body, Controller, Get, Post } from '@nestjs/common';
import * as fs from 'fs';
import * as path from 'path';
import { AvitoWatcherService } from './avito.watcher.service';
import { EventBus } from './event-bus';

type BindState = { url: string; boundAt: string };

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
    return {
      bound: Boolean(state?.url),
      url: state?.url ?? null,
      boundAt: state?.boundAt ?? null,
    };
  }

  /**
   * Binds current Puppeteer page URL as the target chat.
   * Use flow: run with HEADLESS=false, login, open the desired chat manually, then POST /bind/current.
   */
  @Post('current')
  async bindCurrent(@Body() _body: any) {
    const activeUrl = (this.watcher.getActiveUrl() ?? '').trim();
    const picked = await this.watcher.pickBestBindUrl(activeUrl);
    const url = (picked ?? '').trim();
    if (!url) {
      return { ok: false, error: 'No active Puppeteer page URL (is browser running?)' };
    }
    if (!/avito\.ru\/(profile\/)?messenger\//i.test(url)) {
      return { ok: false, error: `Current URL does not look like Avito messenger: ${url}` };
    }

    const state: BindState = { url, boundAt: new Date().toISOString() };
    fs.writeFileSync(this.bindFilePath, JSON.stringify(state, null, 2), 'utf-8');

    this.bus.emit({
      type: 'status',
      level: 'info',
      message: `Target chat bound: ${url}`,
      at: new Date().toISOString(),
    });

    return { ok: true, ...state };
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
      return { url, boundAt: boundAt || null } as any;
    } catch {
      return null;
    }
  }
}
