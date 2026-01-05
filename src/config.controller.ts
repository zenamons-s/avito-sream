import { Controller, Get } from '@nestjs/common';

@Controller('config')
export class ConfigController {
  @Get()
  getConfig() {
    return { publicUrl: process.env.PUBLIC_URL ?? null };
  }
}
