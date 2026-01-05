import { Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { spawn, ChildProcessWithoutNullStreams } from 'child_process';
import { EventBus } from './event-bus';

@Injectable()
export class CloudpubService implements OnModuleInit, OnModuleDestroy {
  private proc?: ChildProcessWithoutNullStreams;
  private stopping = false;

  constructor(private readonly bus: EventBus) {}

  onModuleInit() {
    if (process.env.NODE_ENV === 'test') {
      this.bus.emit({
        type: 'status',
        level: 'info',
        message: 'Cloudpub tunnel skipped in test environment.',
        at: new Date().toISOString(),
      });
      return;
    }

    const enabled = String(process.env.CLOUDPUB_ENABLED ?? 'false') === 'true';
    if (!enabled) {
      this.bus.emit({
        type: 'status',
        level: 'info',
        message: 'Cloudpub tunnel disabled (CLOUDPUB_ENABLED=false).',
        at: new Date().toISOString(),
      });
      return;
    }

    const port = Number(process.env.PORT ?? 3000);
    const bin = process.env.CLOUDPUB_BIN?.trim() || 'cloudpub';

    this.bus.emit({
      type: 'status',
      level: 'info',
      message: `Cloudpub tunnel starting (${bin} http ${port})…`,
      at: new Date().toISOString(),
    });

    try {
      this.proc = spawn(bin, ['http', String(port)], {
        env: {
          ...process.env,
        },
        stdio: 'pipe',
      });
    } catch (error) {
      this.bus.emit({
        type: 'status',
        level: 'error',
        message: `Cloudpub spawn failed: ${String(error)}`,
        at: new Date().toISOString(),
      });
      return;
    }

    this.proc.stdout.on('data', (chunk) => {
      const text = chunk.toString().trim();
      if (!text) return;
      this.bus.emit({
        type: 'status',
        level: 'info',
        message: `cloudpub: ${text}`,
        at: new Date().toISOString(),
      });
    });

    this.proc.stderr.on('data', (chunk) => {
      const text = chunk.toString().trim();
      if (!text) return;
      this.bus.emit({
        type: 'status',
        level: 'warn',
        message: `cloudpub: ${text}`,
        at: new Date().toISOString(),
      });
    });

    this.proc.on('error', (error) => {
      this.bus.emit({
        type: 'status',
        level: 'error',
        message: `Cloudpub error: ${String(error)}`,
        at: new Date().toISOString(),
      });
    });

    this.proc.on('close', (code, signal) => {
      if (this.stopping) return;
      this.bus.emit({
        type: 'status',
        level: 'error',
        message: `Cloudpub exited (code=${code ?? 'null'}, signal=${signal ?? 'null'}).`,
        at: new Date().toISOString(),
      });
    });
  }

  async onModuleDestroy() {
    this.stopping = true;
    await this.stopTunnel();
  }

  private stopTunnel() {
    if (!this.proc) return Promise.resolve();

    const proc = this.proc;
    this.proc = undefined;

    this.bus.emit({
      type: 'status',
      level: 'info',
      message: 'Stopping cloudpub tunnel…',
      at: new Date().toISOString(),
    });

    return new Promise<void>((resolve) => {
      const timeout = setTimeout(() => {
        proc.kill('SIGKILL');
      }, 5000);

      proc.once('close', () => {
        clearTimeout(timeout);
        resolve();
      });

      proc.kill('SIGTERM');
    });
  }
}
