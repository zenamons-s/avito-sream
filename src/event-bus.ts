import { Injectable } from '@nestjs/common';
import { Subject } from 'rxjs';

export type StreamEvent =
  | { type: 'status'; level: 'info' | 'warn' | 'error'; message: string; at: string }
  | { type: 'message'; from: string; text: string; at: string };

@Injectable()
export class EventBus {
  private readonly subject = new Subject<StreamEvent>();
  readonly events$ = this.subject.asObservable();

  emit(event: StreamEvent) {
    this.subject.next(event);
  }
}
