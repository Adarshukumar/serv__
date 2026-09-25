import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import { homedir, platform } from 'node:os';
import { join } from 'node:path';
import puppeteer, { type Browser, type Page } from 'puppeteer-core';
import { InceptionError, type FetchLike } from '../src/site/index';

/** This instance never attaches to or reads the user's existing Chrome profile. */
export function profilePath(): string {
  if (process.env.MERCURY_PROFILE_DIR) return process.env.MERCURY_PROFILE_DIR;
  if (platform() === 'win32') return join(process.env.LOCALAPPDATA || join(homedir(), 'AppData', 'Local'), 'Mercury Direct', 'Chrome');
  if (platform() === 'darwin') return join(homedir(), 'Library', 'Application Support', 'Mercury Direct', 'Chrome');
  return join(process.env.XDG_DATA_HOME || join(homedir(), '.local', 'share'), 'mercury-direct', 'chrome');
}

export function findChrome(): string {
  const explicit = process.env.CHROME_PATH?.trim();
  if (explicit) {
    if (existsSync(explicit)) return explicit;
    throw new Error(`CHROME_PATH does not exist: ${explicit}`);
  }
  const paths: string[] = [];
  if (platform() === 'win32') {
    for (const base of [process.env.PROGRAMFILES, process.env['PROGRAMFILES(X86)'], process.env.LOCALAPPDATA]) {
      if (base) paths.push(join(base, 'Google', 'Chrome', 'Application', 'chrome.exe'), join(base, 'Microsoft', 'Edge', 'Application', 'msedge.exe'));
    }
  } else if (platform() === 'darwin') {
    paths.push('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge', '/Applications/Chromium.app/Contents/MacOS/Chromium');
  } else {
    for (const command of ['google-chrome-stable', 'google-chrome', 'chromium', 'chromium-browser', 'microsoft-edge']) {
      try {
        const found = execFileSync('which', [command], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
        if (found) paths.push(found);
      } catch { /* not installed */ }
    }
  }
  const found = paths.find(existsSync);
  if (found) return found;
  throw new Error('Chrome, Edge or Chromium was not found. Install one, or set CHROME_PATH to its executable.');
}

type BridgeMessage =
  | { id: string; type: 'head'; status: number; statusText: string; headers: [string, string][] }
  | { id: string; type: 'chunk'; text: string }
  | { id: string; type: 'end' }
  | { id: string; type: 'error'; message: string };

type Pending = {
  resolve: (response: Response) => void;
  reject: (error: Error) => void;
  controller: ReadableStreamDefaultController<Uint8Array> | null;
  signal?: AbortSignal;
  onAbort: () => void;
  timer: ReturnType<typeof setTimeout>;
  head: boolean;
  wake: (() => void) | null;
};

const INITIAL_TIMEOUT_MS = 35_000;
const FIRST_RESPONSE_TIMEOUT_MS = 45_000;
const IDLE_TIMEOUT_MS = 120_000;
const ALLOWED_PATHS = new Set(['/api/session', '/api/chat', '/api/follow-ups']);

export interface SiteBrowserOptions {
  siteUrl: string;
  chromePath?: string;
  headless?: boolean;
  chromeArgs?: string[];
  userDataDir?: string;
  onLost?: (message: string) => void;
}

/**
 * A dedicated *real Chrome page* on chat.inceptionlabs.ai, running on the user's
 * computer. All site calls are same-origin window.fetch with browser cookies. The
 * Node companion never forwards a site session token or cookie to the local UI.
 *
 * This is not a CORS bypass: code executes inside a page *at the site's origin*.
 * If the site asks for a human security check, the browser window is visible and
 * the user completes it there. We never try to solve or evade a checkpoint.
 */
export class SiteBrowser {
  private readonly origin: string;
  private readonly siteUrl: string;
  private readonly binding = `__mercuryBridge_${randomUUID().replace(/-/g, '')}`;
  private readonly tasks = `__mercuryTasks_${randomUUID().replace(/-/g, '')}`;
  private readonly jobs = new Map<string, Pending>();
  private readonly boundPages = new WeakSet<Page>();
  private browser: Browser | null = null;
  private page: Page | null = null;
  private launching: Promise<Page> | null = null;
  private closed = false;

  constructor(private readonly options: SiteBrowserOptions) {
    const site = new URL(options.siteUrl);
    this.origin = site.origin;
    this.siteUrl = site.toString();
  }

  get isOpen(): boolean {
    return Boolean(this.page && !this.page.isClosed() && this.browser?.connected);
  }

  get fetch(): FetchLike {
    return (url, init) => this.request(url, init);
  }

  async open(): Promise<Page> {
    if (this.closed) throw new Error('The local companion has stopped.');
    if (this.isOpen && new URL(this.page!.url()).origin === this.origin) return this.page!;
    if (this.launching) return this.launching;
    this.launching = this.launch();
    try {
      return await this.launching;
    } finally {
      this.launching = null;
    }
  }

  async showSite(): Promise<void> {
    const page = await this.open();
    await page.bringToFront();
  }

  async close(): Promise<void> {
    this.closed = true;
    this.failAll(new Error('The local browser was closed.'));
    // If shutdown races launch, don't leave an orphaned Chrome process behind.
    await this.launching?.catch(() => {});
    const browser = this.browser;
    this.page = null;
    this.browser = null;
    if (browser?.connected) await browser.close().catch(() => {});
  }

  private async launch(): Promise<Page> {
    if (!this.browser?.connected) {
      const dir = this.options.userDataDir ?? profilePath();
      mkdirSync(dir, { recursive: true, mode: 0o700 });
      this.browser = await puppeteer.launch({
        executablePath: this.options.chromePath ?? findChrome(),
        headless: this.options.headless ?? false,
        userDataDir: dir,
        args: ['--no-first-run', '--no-default-browser-check', ...(this.options.chromeArgs ?? [])],
      });
      const browser = this.browser;
      browser.on('disconnected', () => {
        if (this.browser !== browser) return;
        this.page = null;
        this.browser = null;
        this.failAll(new Error('The site browser was closed. Reconnect to reopen it.'));
        if (!this.closed) this.options.onLost?.('The site browser was closed.');
      });
      if (this.closed) {
        await browser.close().catch(() => {});
        throw new Error('The local companion has stopped.');
      }
    }
    // Reuse Chrome's initial blank tab rather than leaving an unnecessary tab
    // next to the site window on every fresh launch.
    const blank = (await this.browser.pages()).find((p) => p.url() === 'about:blank');
    const page = this.page && !this.page.isClosed() ? this.page : (blank ?? await this.browser.newPage());
    this.page = page;
    page.on('close', () => {
      if (this.page === page) {
        this.page = null;
        this.failAll(new Error('The site tab was closed. Reconnect to reopen it.'));
        if (!this.closed) this.options.onLost?.('The site tab was closed.');
      }
    });
    page.on('framenavigated', (frame) => {
      if (frame !== page.mainFrame()) return;
      this.failAll(new Error('The site tab navigated during a request.'));
    });
    if (!this.boundPages.has(page)) {
      await page.exposeFunction(this.binding, async (data: BridgeMessage) => this.deliver(data));
      this.boundPages.add(page);
    }
    if (page.url() === 'about:blank' || new URL(page.url()).origin !== this.origin) {
      try {
        await page.goto(this.siteUrl, { waitUntil: 'domcontentloaded', timeout: INITIAL_TIMEOUT_MS });
      } catch (error) {
        throw new InceptionError('network', 'The site browser could not open Inception.', { cause: error });
      }
    }
    if (new URL(page.url()).origin !== this.origin) {
      throw new InceptionError('protocol', 'The site browser is not on chat.inceptionlabs.ai. Return to that site, then reconnect.');
    }
    return page;
  }

  private async request(input: string, init: RequestInit = {}): Promise<Response> {
    const target = new URL(input);
    if (target.origin !== this.origin || !ALLOWED_PATHS.has(target.pathname) || target.search || target.hash) {
      throw new Error('The local companion only calls the three known Inception site endpoints.');
    }
    const method = init.method ?? 'GET';
    if ((target.pathname === '/api/session' ? 'GET' : 'POST') !== method.toUpperCase()) {
      throw new Error('The site endpoint does not accept this method.');
    }
    const page = await this.open();
    const id = randomUUID();
    const headers = Object.fromEntries(new Headers(init.headers).entries());
    const body = typeof init.body === 'string' ? init.body : undefined;
    const signal = init.signal ?? undefined;
    if (signal?.aborted) throw new InceptionError('aborted', 'Request cancelled.');

    return new Promise<Response>((resolve, reject) => {
      const onAbort = () => {
        this.cancel(id, new InceptionError('aborted', 'Request cancelled.'));
      };
      const job: Pending = {
        resolve, reject, controller: null, signal, onAbort, head: false, wake: null,
        timer: setTimeout(() => this.cancel(id, new Error('The site took too long to answer.')), FIRST_RESPONSE_TIMEOUT_MS),
      };
      this.jobs.set(id, job);
      signal?.addEventListener('abort', onAbort, { once: true });

      // Intentionally not awaited: the first `head` callback resolves this promise;
      // the browser keeps pumping bytes until `end` or cancellation.
      void page.evaluate(
        async ({ path, origin, id, method, headers, body, binding, tasks }) => {
          const scope = window as unknown as Record<string, unknown>;
          const host = scope[binding] as (packet: BridgeMessage) => Promise<void>;
          const all = (scope[tasks] ??= new Map<string, AbortController>()) as Map<string, AbortController>;
          const controller = new AbortController();
          all.set(id, controller);
          const decoder = new TextDecoder('utf-8');
          try {
            // A manual navigation may race open(). Never send x-session-token
            // from another origin, even briefly, to an unintended site.
            if (location.origin !== origin) throw new Error('The site tab left Inception; no request sent.');
            const response = await fetch(origin + path, {
              method,
              headers,
              body,
              credentials: 'include',
              cache: 'no-store',
              signal: controller.signal,
            });
            await host({ id, type: 'head', status: response.status, statusText: response.statusText, headers: [...response.headers] });
            if (response.body) {
              const reader = response.body.getReader();
              for (;;) {
                const { value, done } = await reader.read();
                if (done) break;
                const text = decoder.decode(value, { stream: true });
                if (text) await host({ id, type: 'chunk', text });
              }
              const rest = decoder.decode();
              if (rest) await host({ id, type: 'chunk', text: rest });
            }
            await host({ id, type: 'end' });
          } catch (error) {
            await host({ id, type: 'error', message: error instanceof Error ? error.message : 'Site request failed' }).catch(() => {});
          } finally {
            all.delete(id);
          }
        },
        { path: target.pathname, origin: this.origin, id, method, headers, body, binding: this.binding, tasks: this.tasks },
      ).catch((error) => this.cancel(id, new Error(`The site tab stopped responding: ${String(error)}`)));
    });
  }

  private async deliver(data: BridgeMessage): Promise<void> {
    if (!data || typeof data !== 'object' || typeof data.id !== 'string') return;
    const job = this.jobs.get(data.id);
    if (!job) return;
    if (data.type === 'head') {
      if (job.head || data.status < 200 || data.status > 599) return;
      job.head = true;
      clearTimeout(job.timer);
      job.timer = setTimeout(() => this.cancel(data.id, new Error('Inception stopped sending data.')), IDLE_TIMEOUT_MS);
      let stream: ReadableStream<Uint8Array> | null = null;
      if (![204, 205, 304].includes(data.status)) {
        stream = new ReadableStream<Uint8Array>({
          start: (controller) => { job.controller = controller; },
          pull: () => { job.wake?.(); job.wake = null; },
          cancel: () => { this.cancel(data.id, new InceptionError('aborted', 'Request cancelled.')); },
        }, { highWaterMark: 16 });
      }
      job.resolve(new Response(stream, { status: data.status, statusText: data.statusText, headers: data.headers }));
      return;
    }
    if (!job.head) return;
    clearTimeout(job.timer);
    job.timer = setTimeout(() => this.cancel(data.id, new Error('Inception stopped sending data.')), IDLE_TIMEOUT_MS);
    if (data.type === 'chunk') {
      if (typeof data.text !== 'string' || data.text.length > 2_000_000) return this.cancel(data.id, new Error('Site response chunk too large.'));
      job.controller?.enqueue(new TextEncoder().encode(data.text));
      if (job.controller && job.controller.desiredSize !== null && job.controller.desiredSize <= 0) {
        await new Promise<void>((resolve) => { job.wake = resolve; });
      }
    } else if (data.type === 'end') {
      job.controller?.close();
      this.cleanup(data.id);
    } else if (data.type === 'error') {
      this.cancel(data.id, new Error('The site connection closed while fetching.'));
    }
  }

  private cleanup(id: string): Pending | undefined {
    const job = this.jobs.get(id);
    if (!job) return undefined;
    this.jobs.delete(id);
    clearTimeout(job.timer);
    job.signal?.removeEventListener('abort', job.onAbort);
    job.wake?.();
    job.wake = null;
    return job;
  }

  private cancel(id: string, error: Error): void {
    const job = this.cleanup(id);
    if (!job) return;
    if (job.head) {
      try { job.controller?.error(error); } catch { /* already closed */ }
    } else job.reject(error);
    if (this.page && !this.page.isClosed()) {
      void this.page.evaluate(({ id, tasks }) => {
        const all = (window as unknown as Record<string, unknown>)[tasks] as Map<string, AbortController> | undefined;
        all?.get(id)?.abort();
      }, { id, tasks: this.tasks }).catch(() => {});
    }
  }

  private failAll(error: Error): void {
    for (const id of this.jobs.keys()) this.cancel(id, error);
  }
}
