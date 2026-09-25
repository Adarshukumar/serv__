import { randomBytes } from 'node:crypto';
import { createReadStream, existsSync, statSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { extname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { InceptionClient, InceptionError, SESSION_REFRESH_MS, SessionManager, isThinkingMode, toInceptionError, type ChatTurn } from '../src/site/index';
import { SiteBrowser, type SiteBrowserOptions } from './site-browser';

const DEFAULT_SITE = 'https://chat.inceptionlabs.ai';
const DEFAULT_PORT = 4173;
const MAX_REQUEST_BYTES = 300_000;
const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.woff2': 'font/woff2',
  '.woff': 'font/woff', '.ttf': 'font/ttf', '.json': 'application/json; charset=utf-8',
};

export type LocalStatusName = 'connecting' | 'live' | 'challenge' | 'offline' | 'error';
export interface LocalStatus {
  mode: 'local';
  status: LocalStatusName;
  siteHost: string;
  message?: string;
  detail?: string;
  browserOpen: boolean;
  fetchedAt: number | null;
  issuedAt: number | null;
  refreshCount: number;
  /** These are NOT the session token. They are timestamps and counts only. */
}

export interface CompanionOptions {
  /** The production CLI never overrides this; tests use a local protocol simulator. */
  siteUrl?: string;
  port?: number;
  browser?: Omit<SiteBrowserOptions, 'siteUrl' | 'onLost'>;
  distDir?: string;
  /** Only for tests: disable periodic reconnects. */
  autoRefresh?: boolean;
}

export class Companion {
  private readonly siteUrl: string;
  private readonly siteHost: string;
  private readonly browser: SiteBrowser;
  private readonly session: SessionManager;
  private readonly client: InceptionClient;
  private readonly secret = randomBytes(32).toString('base64url');
  private readonly distDir: string;
  private status: Omit<LocalStatus, 'mode' | 'siteHost' | 'browserOpen' | 'fetchedAt' | 'issuedAt' | 'refreshCount'> = { status: 'connecting' };
  private server: Server | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private inflightConnect: Promise<boolean> | null = null;
  private lastAttempt = 0;
  private closed = false;
  private readonly port: number;

  constructor(private readonly options: CompanionOptions = {}) {
    this.siteUrl = (options.siteUrl ?? DEFAULT_SITE).replace(/\/+$/, '');
    this.siteHost = new URL(this.siteUrl).host;
    this.port = options.port ?? DEFAULT_PORT;
    this.distDir = resolve(options.distDir ?? fileURLToPath(new URL('../dist/', import.meta.url)));
    this.browser = new SiteBrowser({
      siteUrl: this.siteUrl,
      ...options.browser,
      onLost: (message) => {
        this.session.reset();
        if (!this.closed) this.status = { status: 'offline', message };
      },
    });
    this.session = new SessionManager({ baseUrl: this.siteUrl, fetch: this.browser.fetch });
    this.client = new InceptionClient({ baseUrl: this.siteUrl, session: this.session, getFetch: () => this.browser.fetch });
  }

  get url(): string {
    const address = this.server?.address();
    const port = address && typeof address === 'object' ? address.port : this.port;
    return `http://127.0.0.1:${port}`;
  }

  getStatus(): LocalStatus {
    const s = this.session.getState();
    return {
      mode: 'local', siteHost: this.siteHost, browserOpen: this.browser.isOpen,
      ...this.status, fetchedAt: s.fetchedAt, issuedAt: s.issuedAt, refreshCount: s.refreshCount,
    };
  }

  async start(): Promise<void> {
    if (!existsSync(resolve(this.distDir, 'index.html'))) throw new Error('dist/ is missing. Run `npm run build` first.');
    this.server = createServer((req, res) => void this.handle(req, res).catch((error) => {
      if (res.writableEnded || res.destroyed) return;
      this.json(res, 500, { error: { kind: 'server', message: 'The local companion failed to handle this request.' } });
      console.error('[mercury] Local server error:', error instanceof Error ? error.message : 'unknown');
    }));
    await new Promise<void>((done, fail) => {
      this.server!.once('error', fail);
      this.server!.listen(this.port, '127.0.0.1', () => {
        this.server!.off('error', fail);
        done();
      });
    });
    // One browser session is created on start. Challenge: wait for the user to pass
    // the site's own check in the Chrome window, then re-probe automatically.
    void this.connect();
    if (this.options.autoRefresh !== false) {
      this.timer = setInterval(() => {
        if (this.status.status === 'live') {
          const age = this.session.tokenAge();
          if (age !== null && age >= SESSION_REFRESH_MS) void this.connect();
        } else if (Date.now() - this.lastAttempt > (this.status.status === 'challenge' ? 8_000 : 25_000)) {
          void this.connect();
        }
      }, 5_000);
      this.timer.unref();
    }
  }

  async close(): Promise<void> {
    this.closed = true;
    if (this.timer) clearInterval(this.timer);
    await this.browser.close();
    if (this.server) {
      this.server.closeAllConnections();
      await new Promise<void>((done) => this.server!.close(() => done()));
      this.server = null;
    }
  }

  /** Single-flight session probe. It reads the token inside the dedicated browser. */
  connect(): Promise<boolean> {
    if (this.inflightConnect) return this.inflightConnect;
    this.lastAttempt = Date.now();
    this.status = { status: 'connecting', message: this.browser.isOpen ? 'Creating a session…' : 'Opening the Inception site on this computer…' };
    const task = (async () => {
      try {
        await this.browser.open();
        await this.session.refresh();
        if (this.closed || !this.browser.isOpen || !this.session.isFresh()) {
          throw new InceptionError('network', 'The site browser closed during the session request.');
        }
        this.status = { status: 'live' };
        return true;
      } catch (error) {
        const err = toInceptionError(error);
        if (err.kind === 'challenge') {
          this.status = { status: 'challenge', message: 'Inception wants this browser to pass its security check.', detail: 'Complete the check in the Chrome window that opened on your computer. The companion will reconnect automatically.' };
        } else {
          this.status = { status: err.kind === 'network' ? 'offline' : 'error', message: err.message, detail: err.detail };
        }
        return false;
      }
    })();
    this.inflightConnect = task;
    void task.finally(() => { if (this.inflightConnect === task) this.inflightConnect = null; });
    return task;
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');

    const host = req.headers.host ?? '';
    const address = this.server?.address();
    const port = address && typeof address === 'object' ? address.port : this.port;
    if (host !== `127.0.0.1:${port}` && host !== `localhost:${port}`) {
      this.json(res, 403, { error: 'Only localhost is allowed.' });
      return;
    }
    const target = new URL(req.url ?? '/', `http://${host}`);
    const path = target.pathname;

    if (path.startsWith('/_local/')) {
      if (req.method === 'GET' && path === '/_local/status') {
        this.json(res, 200, { ...this.getStatus(), csrf: this.secret });
        return;
      }
      if (req.method !== 'POST' || req.headers.origin !== `http://${host}` || req.headers['x-mercury-local'] !== this.secret) {
        this.json(res, 403, { error: 'This request must come from the local Mercury page.' });
        return;
      }
      if (path === '/_local/connect') {
        this.json(res, 200, { ok: await this.connect(), ...this.getStatus() });
        return;
      }
      if (path === '/_local/open-site') {
        try {
          await this.browser.showSite();
          this.json(res, 200, { ok: true });
        } catch (error) {
          this.json(res, 503, { error: toInceptionError(error).message });
        }
        return;
      }
      if (path === '/_local/chat') {
        await this.chat(req, res);
        return;
      }
      if (path === '/_local/follow-ups') {
        const body = await this.readBody(req);
        if (!body || !isTurns(body.turns, false)) {
          this.json(res, 400, { error: 'Invalid conversation.' });
          return;
        }
        this.json(res, 200, { follow_ups: await this.client.followUps(body.turns) });
        return;
      }
      this.json(res, 404, { error: 'Unknown local route.' });
      return;
    }

    if (req.method !== 'GET' && req.method !== 'HEAD') {
      this.json(res, 405, { error: 'Method not allowed.' });
      return;
    }
    this.staticFile(path, res, req.method === 'HEAD');
  }

  private async chat(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const data = await this.readBody(req);
    if (!data || typeof data.chatId !== 'string' || !/^[\w-]{8,64}$/.test(data.chatId)
      || !isTurns(data.turns, true) || !isThinkingMode(data.thinking)
      || typeof data.webSearch !== 'boolean' || typeof data.system !== 'string' || data.system.length > 4_000
      || (data.timezone !== undefined && (typeof data.timezone !== 'string' || data.timezone.length > 80))) {
      this.json(res, 400, { error: { kind: 'invalid', message: 'Invalid chat request.' } });
      return;
    }
    if (this.status.status !== 'live' && !(await this.connect())) {
      this.json(res, 503, { error: { kind: this.status.status, message: this.status.message, detail: this.status.detail } });
      return;
    }
    const controller = new AbortController();
    res.on('close', () => controller.abort());
    res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-store', 'X-Accel-Buffering': 'no' });
    const emit = async (value: unknown) => {
      if (res.destroyed || res.writableEnded) return;
      if (res.write(`data: ${JSON.stringify(value)}\n\n`) || res.destroyed || res.writableEnded) return;
      // Respect a slow local UI: don't buffer an unlimited upstream stream in
      // Node. If the UI disconnects, its AbortController stops the site fetch.
      await new Promise<void>((resolve) => {
        const ready = () => {
          res.off('drain', ready);
          res.off('close', ready);
          resolve();
        };
        res.once('drain', ready);
        res.once('close', ready);
      });
    };
    try {
      for await (const event of this.client.chat({
        chatId: data.chatId, turns: data.turns, thinking: data.thinking, webSearch: data.webSearch,
        system: data.system, timezone: data.timezone, signal: controller.signal,
      })) {
        await emit(event);
      }
    } catch (error) {
      const err = toInceptionError(error);
      if (err.kind === 'challenge') {
        this.status = { status: 'challenge', message: err.message, detail: 'Complete the security check in the Chrome site window. The companion will reconnect automatically.' };
      } else if (err.kind === 'auth') {
        this.session.invalidate();
        this.status = { status: 'error', message: 'Inception refused this session. Reconnect to make a new one.' };
      }
      if (err.kind !== 'aborted') await emit({ type: 'error', kind: err.kind, message: err.message, detail: err.detail });
    } finally {
      if (!res.destroyed) res.end('data: [DONE]\n\n');
    }
  }

  private async readBody(req: IncomingMessage): Promise<Record<string, unknown> | null> {
    let bytes = 0;
    const parts: Buffer[] = [];
    try {
      for await (const part of req) {
        const chunk = Buffer.isBuffer(part) ? part : Buffer.from(part as string);
        bytes += chunk.byteLength;
        if (bytes > MAX_REQUEST_BYTES) throw new Error('Request too large.');
        parts.push(chunk);
      }
      const parsed: unknown = JSON.parse(Buffer.concat(parts).toString('utf8'));
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : null;
    } catch {
      return null;
    }
  }

  private staticFile(path: string, res: ServerResponse, head: boolean): void {
    const file = resolve(this.distDir, `.${path === '/' ? '/index.html' : path}`);
    if (!file.startsWith(this.distDir + sep) && file !== this.distDir) {
      this.json(res, 404, { error: 'Not found.' });
      return;
    }
    let target = file;
    if (!existsSync(target) || !statSync(target).isFile()) {
      if (extname(target)) {
        this.json(res, 404, { error: 'Not found.' });
        return;
      }
      target = resolve(this.distDir, 'index.html'); // SPA route
    }
    res.writeHead(200, { 'Content-Type': MIME[extname(target)] ?? 'application/octet-stream', 'Cache-Control': target.endsWith('index.html') ? 'no-cache' : 'public, max-age=31536000, immutable' });
    if (head) res.end();
    else createReadStream(target).pipe(res);
  }

  private json(res: ServerResponse, code: number, data: unknown): void {
    res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify(data));
  }
}

function isTurns(value: unknown, lastUser: boolean): value is ChatTurn[] {
  if (!Array.isArray(value) || value.length < (lastUser ? 1 : 2) || value.length > 100) return false;
  let size = 0;
  for (const turn of value) {
    if (!turn || typeof turn !== 'object' || !['user', 'assistant'].includes(turn.role)
      || typeof turn.text !== 'string' || !turn.text.trim() || turn.text.length > 30_000
      || (turn.id !== undefined && (typeof turn.id !== 'string' || !/^[\w-]{8,64}$/.test(turn.id)))) return false;
    size += turn.text.length;
  }
  return size <= 200_000 && (!lastUser || value.at(-1)?.role === 'user');
}

/** Start the companion on loopback, never on 0.0.0.0 or a remote IP. */
export async function createCompanion(options: CompanionOptions = {}): Promise<Companion> {
  const companion = new Companion(options);
  await companion.start();
  return companion;
}
