// @ts-check
/**
 * Browser end-to-end test of the real UI, in a real Chromium, against the local
 * protocol simulator (tests/fixtures/mock-inception.mjs). It drives the page like a
 * person: waits for the session, sends messages, watches tokens stream in, stops a
 * stream, hits errors, reloads, switches themes — and saves screenshots.
 *
 *   CHROME_PATH=/path/to/chrome npm run test:e2e
 *
 * Optional: CHROME_ARGS="--flag --flag", HEADLESS=shell|true, SCREENSHOTS=dir
 *
 * The page runs as a normal web page here (headless Chrome can't load extensions),
 * so the simulator enables CORS. Extension-only pieces (host permissions, header
 * rules, site-tab bridge) are covered by tests/extension.test.ts.
 */
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer-core';
import { createServer } from 'vite';
import { startMockInception } from '../fixtures/mock-inception.mjs';

const root = fileURLToPath(new URL('../..', import.meta.url));
const shots = process.env.SCREENSHOTS ?? `${root}tests/e2e/screenshots`;
const chromePath = process.env.CHROME_PATH;
if (!chromePath) {
  console.error('Set CHROME_PATH to a Chrome or Chromium executable.');
  process.exit(2);
}
mkdirSync(shots, { recursive: true });

const results = [];
let failures = 0;
async function step(name, fn) {
  const started = Date.now();
  try {
    await fn();
    results.push(`  ✓ ${name} (${Date.now() - started} ms)`);
  } catch (error) {
    failures++;
    results.push(`  ✗ ${name}\n      ${error instanceof Error ? error.message : error}`);
  }
}
function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function startApp(baseUrl) {
  process.env.VITE_INCEPTION_BASE_URL = baseUrl;
  const server = await createServer({
    root,
    configFile: `${root}vite.config.ts`,
    logLevel: 'error',
    server: { host: '127.0.0.1', port: 0, strictPort: false },
  });
  await server.listen();
  const address = server.httpServer?.address();
  const port = typeof address === 'object' && address ? address.port : 5173;
  return { server, url: `http://127.0.0.1:${port}/` };
}

const mock = await startMockInception({ cors: true, deltaDelayMs: 22 });
const app = await startApp(mock.url);
const browser = await puppeteer.launch({
  executablePath: chromePath,
  headless: process.env.HEADLESS === 'shell' ? 'shell' : true,
  args: (process.env.CHROME_ARGS ?? '--no-sandbox --disable-dev-shm-usage --font-render-hinting=none').split(/\s+/).filter(Boolean),
});

const page = await browser.newPage();
await page.setViewport({ width: 1440, height: 940, deviceScaleFactor: 1 });
const pageErrors = [];
page.on('pageerror', (error) => pageErrors.push(String(error)));
page.on('console', (msg) => {
  if (msg.type() === 'error') pageErrors.push(msg.text());
});

const shot = (name) => page.screenshot({ path: `${shots}/${name}.png` });
const textOf = (selector) => page.$eval(selector, (el) => el.textContent ?? '');
const count = (selector) => page.$$eval(selector, (els) => els.length);
async function ask(text) {
  await page.click('#composer-input');
  await page.type('#composer-input', text);
  await page.keyboard.press('Enter');
}
async function waitForAnswers(n, timeout = 30_000) {
  await page.waitForFunction(
    (expected) => document.querySelectorAll('.turn--assistant[aria-busy="false"]').length >= expected,
    { timeout },
    n,
  );
}

await step('creates the session on start and shows it as live', async () => {
  await page.goto(app.url, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('.status-pill[data-tone="ok"]', { timeout: 15_000 });
  assert((await textOf('.status-pill')).includes('Live'), 'status pill should say Live');
  await page.waitForFunction(() => document.fonts.status === 'loaded');
  const sessions = mock.state.log.filter((l) => l.path === '/api/session' && l.status === 200);
  assert(sessions.length >= 1, 'GET /api/session should have been called');
  await shot('01-masthead');
});

await step('streams a real answer token by token, with thinking and sources', async () => {
  await ask('Why is the sky blue?');
  await page.waitForSelector('.thinking', { timeout: 10_000 });
  await page.waitForSelector('.prose .caret', { timeout: 15_000 });
  const early = (await textOf('.prose')).length;
  await shot('02-streaming');
  await new Promise((r) => setTimeout(r, 400));
  const later = (await textOf('.prose')).length;
  assert(later > early, `text should grow while streaming (${early} → ${later})`);
  await waitForAnswers(1);
  assert((await count('.prose .caret')) === 0, 'caret should disappear when done');
});

await step('renders the finished answer: markdown, math, code, multi-byte text', async () => {
  const prose = await textOf('.prose');
  assert(prose.includes('नमस्ते 👋 — café ✓'), 'multi-byte text must arrive intact');
  assert((await count('.prose h2')) === 1, 'heading rendered');
  assert((await count('.prose .katex')) >= 2, 'inline + display math rendered');
  assert(prose.includes('prices do not: $5 and $10.'), 'currency must not become math');
  assert((await textOf('.code-block .code-lang')) === 'python', 'code block labelled');
  assert((await count('.code-block .hljs-keyword')) >= 1, 'code highlighted');
});

await step('keeps every distinct source (3 of 4, one duplicate) and shows follow-ups', async () => {
  assert((await count('.sources li')) === 3, `expected 3 sources, got ${await count('.sources li')}`);
  await page.waitForSelector('.follow-ups li', { timeout: 10_000 });
  assert((await count('.follow-ups li')) === 3, 'three follow-ups');
  assert((await textOf('.thinking-label')).startsWith('Thought for'), 'thinking summary shows duration');
  await page.$eval('.scroller', (el) => el.scrollTo(0, 0));
  await shot('03-answer');
});

await step('continues the conversation with full history', async () => {
  await page.click('.follow-ups li button');
  await waitForAnswers(2);
  const last = mock.state.chats.at(-1);
  assert(last?.messages === 3, `second request should carry 3 messages, got ${last?.messages}`);
  assert(mock.state.chats[0].id === last.id, 'same chat id across turns');
  assert((await count('.exchange')) === 2, 'two exchanges shown');
});

await step('honours thinking mode and web search toggles', async () => {
  await page.click('.modes .mode:nth-child(1)'); // Instant
  await page.click('.toggle'); // web search off
  await ask('Quick question without search');
  await waitForAnswers(3);
  const last = mock.state.chats.at(-1);
  assert(last?.reasoningEffort === 'instant' && last.webSearchEnabled === false, `settings sent: ${JSON.stringify(last)}`);
  const turns = await page.$$('.turn--assistant');
  const lastTurnThinking = await turns.at(-1)?.$('.thinking');
  assert(!lastTurnThinking, 'instant mode has no thinking block');
});

await step('stops a stream on request and keeps what arrived', async () => {
  await ask('Tell me a long story #slow');
  await page.waitForSelector('.send-button--stop', { timeout: 10_000 });
  await page.waitForFunction(() => {
    const turns = document.querySelectorAll('.turn--assistant');
    return (turns[turns.length - 1]?.querySelector('.prose')?.textContent?.length ?? 0) > 20;
  });
  await page.click('.send-button--stop');
  await waitForAnswers(4);
  assert((await count('.stopped-mark')) === 1, 'stopped marker shown');
});

await step('shows stream errors with a retry', async () => {
  await ask('Please fail #error');
  await waitForAnswers(5);
  const note = await textOf('.error-note');
  assert(note.includes('Simulated upstream failure'), `error note: ${note}`);
});

await step('recovers from rate limiting automatically (new conversation)', async () => {
  await page.click('.new-chat');
  await page.waitForSelector('.masthead');
  const before = mock.state.log.filter((l) => l.path === '/api/chat' && l.status === 429).length;
  await ask('Busy server #429');
  await waitForAnswers(1, 40_000);
  const text = await textOf('.turn--assistant');
  assert(text.includes('End of the simulated answer.'), 'answer arrives after 429 retries');
  const limited = mock.state.log.filter((l) => l.path === '/api/chat' && l.status === 429).length - before;
  assert(limited === 2, `expected two 429s before success, saw ${limited}`);
});

await step('persists conversations locally across reloads', async () => {
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => document.querySelectorAll('.list-item').length === 2, { timeout: 10_000 });
  const titles = await page.$$eval('.list-title', (els) => els.map((el) => el.textContent ?? ''));
  assert(titles[0] === 'Busy server #429' && titles[1] === 'Why is the sky blue?', `list order: ${JSON.stringify(titles)}`);
  await page.click('.list-item:nth-of-type(2) .list-title');
  await page.waitForSelector('.exchange');
  assert((await count('.exchange')) === 5, `all exchanges restored, got ${await count('.exchange')}`);
  assert((await count('.error-note')) === 1 && (await count('.stopped-mark')) === 1, 'statuses restored');
  await page.waitForSelector('.status-pill[data-tone="ok"]');
});

await step('night theme and settings sheet', async () => {
  await page.$eval('.scroller', (el) => el.scrollTo(0, 0));
  await page.click('.topbar-actions .icon-button[aria-label^="Switch to night"]');
  await page.waitForFunction(() => document.documentElement.dataset.theme === 'night');
  await new Promise((r) => setTimeout(r, 350));
  await shot('04-night');
  await page.click('.topbar-actions .icon-button[aria-label="Settings"]');
  await page.waitForSelector('.sheet[data-open="true"]');
  await new Promise((r) => setTimeout(r, 400));
  await shot('05-settings');
  await page.keyboard.press('Escape');
  await page.click('.topbar-actions .icon-button[aria-label^="Switch to paper"]');
});

await step('mobile layout', async () => {
  await page.setViewport({ width: 390, height: 844, deviceScaleFactor: 2 });
  await new Promise((r) => setTimeout(r, 300));
  await shot('06-mobile');
  await page.click('.menu-button');
  await page.waitForSelector('.sidebar[data-open="true"]');
  await new Promise((r) => setTimeout(r, 350));
  await shot('07-mobile-sidebar');
  await page.setViewport({ width: 1440, height: 940, deviceScaleFactor: 1 });
});

await step('explains the security checkpoint', async () => {
  mock.setChallenge(true);
  try {
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForSelector('.notice[data-tone="wait"]', { timeout: 10_000 });
    assert((await textOf('.status-pill')).includes('Security check'), 'status shows security check');
    await shot('08-checkpoint');
  } finally {
    mock.setChallenge(false);
  }
});

await step('no errors were logged by the page', async () => {
  const unexpected = pageErrors.filter((e) => !/status of 4\d\d|Failed to load resource/.test(e));
  assert(unexpected.length === 0, `page errors:\n${unexpected.join('\n')}`);
});

// A second instance pointed at the real site: a plain web page can't reach it (CORS).
const real = await startApp('https://chat.inceptionlabs.ai');
await step('as a plain web page, the real site is blocked and the page explains why', async () => {
  const p = await browser.newPage();
  await p.setViewport({ width: 1440, height: 940 });
  await p.goto(real.url, { waitUntil: 'domcontentloaded' });
  await p.waitForSelector('.notice[data-tone="muted"]', { timeout: 20_000 });
  const text = await p.$eval('.notice', (el) => el.textContent ?? '');
  assert(text.includes('Load unpacked'), 'install instructions shown');

  // With `npm run zip` done, the page's own server offers the ready-built extension.
  const { version } = JSON.parse(readFileSync(`${root}package.json`, 'utf8'));
  if (existsSync(`${root}inception-direct-${version}.zip`)) {
    await p.waitForSelector('a.notice-download[download]', { timeout: 10_000 });
    const href = await p.$eval('a.notice-download', (el) => /** @type {HTMLAnchorElement} */ (el).href);
    const res = await fetch(href);
    assert(res.ok && res.headers.get('content-type') === 'application/zip', `download served: ${res.status} ${res.headers.get('content-type')}`);
    assert((res.headers.get('content-disposition') ?? '').includes(`inception-direct-${version}.zip`), 'saved under its versioned name');
    const bytes = new Uint8Array(await res.arrayBuffer());
    assert(bytes[0] === 0x50 && bytes[1] === 0x4b, 'the download is a zip archive');
    assert((await p.$eval('a.notice-download', (el) => el.textContent ?? '')).includes('MB'), 'size shown on the button');
  } else {
    await new Promise((r) => setTimeout(r, 800));
    assert((await p.$('a.notice-download')) === null, 'no download button before `npm run zip`');
  }
  await p.screenshot({ path: `${shots}/09-web-preview-blocked.png` });
  await p.close();
});

await browser.close();
await app.server.close();
await real.server.close();
await mock.close();

console.log(`\nBrowser end-to-end (${failures ? 'FAILED' : 'passed'}):\n${results.join('\n')}\n\nScreenshots: ${shots}`);
process.exit(failures ? 1 : 0);
