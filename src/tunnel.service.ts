import { Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { spawn, ChildProcessWithoutNullStreams } from 'child_process';
import { promises as fs } from 'fs';
import * as readline from 'readline';
import { EventBus } from './event-bus';

@Injectable()
export class TunnelService implements OnModuleInit, OnModuleDestroy {
  private process: ChildProcessWithoutNullStreams | null = null;
  private stdoutRl: readline.Interface | null = null;
  private stderrRl: readline.Interface | null = null;
  private healthTimer: NodeJS.Timeout | null = null;
  private shuttingDown = false;
  private lastHealthSummary: string | null = null;
  private tunnelUrl: string | null = null;
  private readonly urlRegex: RegExp;
  private readonly urlFilePath: string | null;
  private readonly allowedHosts: Set<string> | null;

  constructor(private readonly bus: EventBus) {
    const regexRaw = String(process.env.TUNNEL_URL_REGEX ?? '').trim();
    this.urlRegex = regexRaw
      ? new RegExp(regexRaw)
      : /https?:\/\/[^\s]+/;
    const urlFile = String(process.env.TUNNEL_URL_FILE ?? '').trim();
    this.urlFilePath = urlFile || null;
    const hostsRaw = String(process.env.TUNNEL_URL_HOSTS ?? '').trim();
    this.allowedHosts = hostsRaw
      ? new Set(hostsRaw.split(',').map((host) => host.trim()).filter(Boolean))
      : null;
  }

  onModuleInit() {
    this.startTunnel();
    this.startHealthCheck();
  }

  onModuleDestroy() {
    this.shuttingDown = true;
    if (this.healthTimer) {
      clearInterval(this.healthTimer);
      this.healthTimer = null;
    }
    this.stdoutRl?.close();
    this.stderrRl?.close();
    if (this.process && !this.process.killed) {
      this.process.kill('SIGTERM');
    }
  }

  private startTunnel() {
    const enabled = String(process.env.TUNNEL_ENABLED ?? 'false') === 'true';
    if (!enabled) {
      this.bus.emit({
        type: 'status',
        level: 'info',
        message: 'Tunnel disabled (TUNNEL_ENABLED=false).',
        at: new Date().toISOString(),
      });
      return;
    }

    const command = String(process.env.TUNNEL_COMMAND ?? '').trim();
    if (!command) {
      this.bus.emit({
        type: 'status',
        level: 'warn',
        message: 'Tunnel command not set (TUNNEL_COMMAND).',
        at: new Date().toISOString(),
      });
      return;
    }

    this.bus.emit({
      type: 'status',
      level: 'info',
      message: `Tunnel starting: ${command}`,
      at: new Date().toISOString(),
    });

    const child = spawn(command, {
      shell: true,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: process.env,
    });
    this.process = child;

    this.stdoutRl = readline.createInterface({ input: child.stdout });
    this.stdoutRl.on('line', (line) => this.handleTunnelOutput('stdout', line));

    this.stderrRl = readline.createInterface({ input: child.stderr });
    this.stderrRl.on('line', (line) => this.handleTunnelOutput('stderr', line));

    child.on('error', (err) => {
      this.bus.emit({
        type: 'status',
        level: 'error',
        message: `Tunnel process error: ${err.message}`,
        at: new Date().toISOString(),
      });
    });

    child.on('exit', (code, signal) => {
      const detail = `code=${code ?? 'null'}, signal=${signal ?? 'null'}`;
      if (this.shuttingDown) {
        this.bus.emit({
          type: 'status',
          level: 'info',
          message: `Tunnel stopped (${detail})`,
          at: new Date().toISOString(),
        });
        return;
      }
      this.bus.emit({
        type: 'status',
        level: 'error',
        message: `Tunnel exited unexpectedly (${detail})`,
        at: new Date().toISOString(),
      });
    });
  }

  private handleTunnelOutput(stream: 'stdout' | 'stderr', line: string) {
    const message = line.trim();
    if (!message) return;
    const level = stream === 'stderr' ? 'warn' : 'info';
    this.bus.emit({
      type: 'status',
      level,
      message: `Tunnel ${stream}: ${message}`,
      at: new Date().toISOString(),
    });

    const match = message.match(this.urlRegex);
    if (match?.[0]) {
      const url = match[0];
      if (!this.isAllowedHost(url)) return;
      if (url !== this.tunnelUrl) {
        this.tunnelUrl = url;
        void this.persistUrl(url);
        this.bus.emit({
          type: 'status',
          level: 'info',
          message: `Tunnel URL detected: ${url}`,
          at: new Date().toISOString(),
        });
      }
    }
  }

  private startHealthCheck() {
    const healthUrl = String(process.env.TUNNEL_HEALTH_URL ?? '').trim();
    if (!healthUrl) return;

    const intervalMs = Number(process.env.TUNNEL_HEALTH_INTERVAL_MS ?? 30000);
    const timeoutMs = Number(process.env.TUNNEL_HEALTH_TIMEOUT_MS ?? 5000);

    const runCheck = () => {
      this.checkHealth(healthUrl, timeoutMs).catch((err) => {
        const message = err instanceof Error ? err.message : String(err);
        this.emitHealthStatus(false, `health-check error: ${message}`);
      });
    };

    runCheck();
    this.healthTimer = setInterval(runCheck, intervalMs);
    this.healthTimer.unref?.();
  }

  private async checkHealth(url: string, timeoutMs: number) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const response = await fetch(url, { method: 'HEAD', signal: controller.signal });
      const summary = `status ${response.status}`;
      this.emitHealthStatus(response.ok, summary);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.emitHealthStatus(false, `request failed: ${message}`);
    } finally {
      clearTimeout(timeout);
    }
  }

  private emitHealthStatus(ok: boolean, detail: string) {
    const summary = `${ok ? 'ok' : 'fail'}: ${detail}`;
    if (summary === this.lastHealthSummary) return;
    this.lastHealthSummary = summary;
    this.bus.emit({
      type: 'status',
      level: ok ? 'info' : 'warn',
      message: `Tunnel health ${summary}`,
      at: new Date().toISOString(),
    });
  }

  getTunnelUrl() {
    return this.tunnelUrl;
  }

  private isAllowedHost(url: string) {
    if (!this.allowedHosts || this.allowedHosts.size === 0) return true;
    try {
      const host = new URL(url).host;
      return this.allowedHosts.has(host);
    } catch {
      return false;
    }
  }

  private async persistUrl(url: string) {
    if (!this.urlFilePath) return;
    try {
      await fs.writeFile(this.urlFilePath, `${url}\n`, 'utf8');
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.bus.emit({
        type: 'status',
        level: 'warn',
        message: `Tunnel URL write failed: ${message}`,
        at: new Date().toISOString(),
      });
    }
  }
}
