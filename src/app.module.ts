import { Module } from '@nestjs/common';
import { ServeStaticModule } from '@nestjs/serve-static';
import { join } from 'path';

import { AppService } from './app.service';
import { HealthController } from './health.controller';
import { BindController } from './bind.controller';
import { TunnelController } from './tunnel.controller';
import { WsGateway } from './ws.gateway';
import { EventBus } from './event-bus';
import { AvitoWatcherService } from './avito.watcher.service';
import { TunnelService } from './tunnel.service';
import { CloudpubService } from './cloudpub.service';
import { ConfigController } from './config.controller';

@Module({
  imports: [
    ServeStaticModule.forRoot({
      rootPath: join(process.cwd(), 'src', 'public'),
      serveRoot: '/',
    }),
  ],
  controllers: [
    HealthController,
    BindController,
    TunnelController,
    ConfigController,
  ],
  providers: [
    AppService,
    WsGateway,
    EventBus,
    AvitoWatcherService,
    TunnelService,
    CloudpubService,
  ],
})
export class AppModule {}
