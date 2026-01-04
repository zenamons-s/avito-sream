import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { WsAdapter } from '@nestjs/platform-ws';
import * as dotenv from 'dotenv';

async function bootstrap() {
  dotenv.config();

  const app = await NestFactory.create(AppModule);
  app.useWebSocketAdapter(new WsAdapter(app));

  const port = Number(process.env.PORT ?? 3000);
  await app.listen(port, '0.0.0.0');

  // eslint-disable-next-line no-console
  console.log(`HTTP: http://localhost:${port}/`);
  // eslint-disable-next-line no-console
  console.log(`WS:   ws://localhost:${port}/ws`);
}

bootstrap();
