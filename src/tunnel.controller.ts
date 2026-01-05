import { Controller, Get } from '@nestjs/common';
import { TunnelService } from './tunnel.service';

@Controller('tunnel')
export class TunnelController {
  constructor(private readonly tunnel: TunnelService) {}

  @Get()
  getTunnel() {
    const url = this.tunnel.getTunnelUrl();
    if (!url) {
      return { ok: false };
    }
    return { ok: true, url };
  }
}
