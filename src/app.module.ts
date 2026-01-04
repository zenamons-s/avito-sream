import { Module } from '@nestjs/common';
import { ServeStaticModule } from '@nestjs/serve-static';
import { join } from 'path';

import { AppService } from './app.service';
import { HealthController } from './health.controller';
import { BindController } from './bind.controller';
import { WsGateway } from './ws.gateway';
import { EventBus } from './event-bus';
import { AvitoWatcherService } from './avito.watcher.service';

@Module({
  imports: [
    ServeStaticModule.forRoot({
      rootPath: join(__dirname, 'public'),
      serveRoot: '/',
    }),
  ],
  controllers: [HealthController, BindController],
  providers: [AppService, WsGateway, EventBus, AvitoWatcherService],
})
export class AppModule {}

