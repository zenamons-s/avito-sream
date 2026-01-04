import { OnGatewayConnection, WebSocketGateway, WebSocketServer } from '@nestjs/websockets';
import { Server, WebSocket } from 'ws';
import { EventBus, StreamEvent } from './event-bus';

@WebSocketGateway({ path: '/ws' })
export class WsGateway implements OnGatewayConnection {
  @WebSocketServer()
  server!: Server;

  private history: StreamEvent[] = [];
  private readonly HISTORY_LIMIT = 50;

  constructor(private readonly bus: EventBus) {
    this.bus.events$.subscribe((evt) => {
      this.history.push(evt);
      if (this.history.length > this.HISTORY_LIMIT) this.history.shift();
      this.broadcast(evt);
    });
  }

  handleConnection(client: WebSocket) {
    try {
      client.send(
        JSON.stringify({
          type: 'status',
          level: 'info',
          message: 'WS connected',
          at: new Date().toISOString(),
        }),
      );
    } catch {
      // ignore
    }

    for (const evt of this.history) {
      try {
        client.send(JSON.stringify(evt));
      } catch {
        // ignore
      }
    }
  }

  private broadcast(evt: StreamEvent) {
    const payload = JSON.stringify(evt);
    for (const client of this.server.clients) {
      if (client.readyState !== client.OPEN) continue;
      try {
        client.send(payload);
      } catch {
        // ignore
      }
    }
  }
}
