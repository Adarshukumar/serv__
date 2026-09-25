// @ts-check
/**
 * Browser end-to-end test of the real website, in a real Chromium, against the local
 * API simulator (tests/fixtures/mock-inception.mjs) on a *different origin* — so the
 * browser enforces CORS and sends real preflights, exactly as it does against
 * api.inceptionlabs.ai. It drives the page like a person: adds a key, streams answers,
 * switches models and diffusion, stops, hits errors, reloads — and saves screenshots.
 * Finally it builds the production bundle (strict CSP) and chats through that too.
 *
 *   CHROME_PATH=/path/to/chrome npm run test:e2e
 *
 * Optional: CHROME_ARGS="--flag --flag", HEADLESS=shell|true, SCREENSHOTS=dir
 */
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer-core';
import { build, createServer, preview } from 'vite';
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
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const mock = await startMockInception({ blockDelayMs: 22 });
process.env.VITE_INCEPTION_API_URL = mock.url;
const dev = await createServer({ root, configFile: `${root}vite.config.ts`, logLevel: 'error', server: { host: '127.0.0.1', port: 0, strictPort: false } });
await dev.listen();
const devAddress = dev.httpServer?.address();
const appUrl = `http://127.0.0.1:${typeof devAddress === 'object' && devAddress ? devAddress.port : 5173}/`;

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
const textOf = (selector, p = page) => p.$eval(selector, (el) => el.textContent ?? '');
const count = (selector) => page.$$eval(selector, (els) => els.length);
const chats = (kind = 'chat') => mock.state.requests.filter((r) => r.kind === kind);
/** Click the element whose text is exactly `text` (or starts with it, when `prefix`). */
async function clickText(selector, text, { prefix = false, p = page } = {}) {
  const ok = await p.$$eval(
    selector,
    (els, wanted, byPrefix) => {
      const el = els.find((e) => {
        const t = (e.textContent ?? '').trim();
        return byPrefix ? t.startsWith(wanted) : t === wanted;
      });
      if (el) /** @type {HTMLElement} */ (el).click();
      return Boolean(el);
    },
    text,
    prefix,
  );
  assert(ok, `no ${selector} with text “${text}”`);
}
async function enterKey(key, p = page) {
  await p.waitForSelector('#api-key');
  await p.$eval('#api-key', (el) => {
    /** @type {HTMLInputElement} */ (el).value = '';
  });
  await p.click('#api-key', { clickCount: 3 });
  await p.keyboard.press('Backspace');
  await p.type('#api-key', key);
  await p.click('.key-card button[type="submit"]');
}
async function ask(text, p = page) {
  await p.waitForFunction(() => !(/** @type {HTMLTextAreaElement} */ (document.querySelector('#composer-input'))?.disabled));
  await p.click('#composer-input');
  await p.type('#composer-input', text);
  await p.keyboard.press('Enter');
}
async function waitForAnswers(n, timeout = 30_000, p = page) {
  await p.waitForFunction((expected) => document.querySelectorAll('.turn--assistant[aria-busy="false"]').length >= expected, { timeout }, n);
}

await step('a first visit asks for a key — nothing can be sent without one', async () => {
  await page.goto(appUrl, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('.key-card');
  await page.waitForFunction(() => document.fonts.status === 'loaded');
  assert((await textOf('.status-pill')).includes('Add key'), 'status pill should ask for a key');
  assert(await page.$eval('#composer-input', (el) => /** @type {HTMLTextAreaElement} */ (el).disabled), 'composer disabled without a key');
  assert(chats('handshake').length === 0 && chats().length === 0, 'no completions without a key');
  assert(mock.state.log.some((l) => l.path === '/v1/models' && l.status === 200), 'public model list loaded');
  await sleep(300);
  await shot('01-key-card');
});

await step('a wrong key is refused by Inception, and the page says so', async () => {
  // The card must stay put (no unmount/flash) while the key is being checked.
  await page.evaluate(() => {
    const card = document.querySelector('.key-card');
    /** @type {any} */ (window).__cardRemoved = false;
    new MutationObserver(() => {
      if (!card?.isConnected) /** @type {any} */ (window).__cardRemoved = true;
    }).observe(document.body, { childList: true, subtree: true });
  });
  await enterKey('sk-wrong-key');
  await page.waitForSelector('.key-card[data-tone="bad"] .key-error', { timeout: 10_000 });
  assert(!(await page.evaluate(() => /** @type {any} */ (window).__cardRemoved)), 'the key card stayed on screen during the check');
  assert(await page.$eval('#api-key', (el) => document.activeElement === el), 'the rejected key is focused, ready to be replaced');
  const error = await textOf('.key-error');
  assert(error.includes('didn’t accept') && error.includes('invalid_api_key'), `error text: ${error}`);
  assert((await textOf('.status-pill')).includes('Key rejected'), 'status shows the rejection');
  await shot('02-key-rejected');
});

await step('the right key starts the session with one tiny real handshake — through a CORS preflight', async () => {
  await enterKey('test-key');
  await page.waitForSelector('.status-pill[data-tone="ok"]', { timeout: 10_000 });
  assert((await count('.key-card')) === 0, 'key card closes');
  const handshakes = chats('handshake');
  assert(handshakes.length >= 1 && handshakes.at(-1)?.maxTokens === 1, 'one-token handshake sent');
  const preflight = mock.state.log.find((l) => l.method === 'OPTIONS' && l.path === '/v1/chat/completions');
  assert(preflight?.status === 200, 'the browser sent a CORS preflight and it passed');
  assert(handshakes.at(-1)?.origin === new URL(appUrl).origin, 'request came from the page’s own origin');
  const colophon = await textOf('.masthead-colophon');
  assert(/Live · Mercury 2\.5 · handshake \d+ ms/.test(colophon), `colophon: ${colophon}`);
  assert((await page.evaluate(() => localStorage.getItem('inception-direct.api-key.v1'))) === 'test-key', 'key remembered on this device');
  await sleep(300);
  await shot('03-live');
});

await step('streams a real answer block by block, with a thinking timer and a reasoning summary', async () => {
  await ask('Why is the sky blue?');
  await page.waitForSelector('.status-line', { timeout: 5_000 });
  assert((await textOf('.status-line')).startsWith('Thinking'), 'thinking timer while Mercury reasons');
  await page.waitForSelector('.prose .caret', { timeout: 15_000 });
  const early = (await textOf('.prose')).length;
  await shot('04-streaming');
  await sleep(350);
  const later = (await textOf('.prose')).length;
  assert(later > early, `text should grow while streaming (${early} → ${later})`);
  await waitForAnswers(1);
  assert((await count('.prose .caret')) === 0, 'caret gone when done');
  const label = await textOf('.thinking-label');
  assert(label.startsWith('Thought for') && label.includes('reasoning tokens'), `thinking label: ${label}`);
  await page.click('.thinking summary');
  assert((await textOf('.thinking-body')).includes('Weighed what the question asks'), 'reasoning summary shown');
  const colophon = await textOf('.colophon-meta');
  assert(/\d+ words · \d+ tokens · [\d,]+ tok\/s · first word/.test(colophon), `colophon: ${colophon}`);
});

await step('renders the finished answer: markdown, math, code, multi-byte text', async () => {
  const prose = await textOf('.prose');
  assert(prose.includes('नमस्ते 👋 — café ✓'), 'multi-byte text intact');
  assert((await count('.prose h2')) === 1, 'heading rendered');
  assert((await count('.prose .katex')) >= 2, 'inline + display math rendered');
  assert(prose.includes('prices do not: $5 and $10.'), 'currency is not math');
  assert((await textOf('.code-block .code-lang')) === 'python', 'code block labelled');
  assert((await count('.code-block .hljs-keyword')) >= 1, 'code highlighted');
  await page.$eval('.scroller', (el) => el.scrollTo(0, 0));
  await shot('05-answer');
});

await step('follow-ups are written by the model and continue with the full history', async () => {
  await page.waitForSelector('.follow-ups li', { timeout: 10_000 });
  assert((await count('.follow-ups li')) === 3, 'three follow-ups');
  assert(chats('follow-ups').length === 1, 'one structured-output request for them');
  await page.click('.follow-ups li button');
  await waitForAnswers(2);
  const last = chats().at(-1);
  assert(JSON.stringify(last?.roles) === JSON.stringify(['user', 'assistant', 'user']), `history sent: ${JSON.stringify(last?.roles)}`);
});

await step('honours the model, effort and length settings', async () => {
  await page.click('.topbar-actions .icon-button[aria-label="Settings"]');
  await page.waitForSelector('.sheet[data-open="true"]');
  await clickText('.segmented[aria-label="Model"] button', 'Mercury 2');
  await page.keyboard.press('Escape');
  await page.click('.modes .mode:nth-child(1)'); // Instant
  await ask('Quick one');
  await waitForAnswers(3);
  const last = chats().at(-1);
  assert(last?.model === 'mercury-2' && last.effort === 'instant', `sent: ${JSON.stringify(last)}`);
  assert(last?.reasoningSummary === false && last.maxTokens === 16384 && last.includeUsage === true, `params: ${JSON.stringify(last)}`);
  const turns = await page.$$('.turn--assistant');
  assert(!(await turns.at(-1)?.$('.thinking, .thinking-line')), 'instant has no thinking line');
  assert((await turns.at(-1)?.$eval('.turn-settings', (el) => el.textContent)) === 'Mercury 2 · Instant', 'turn label names model and effort');
});

await step('diffusion view: the canvas is refined in place, then typeset', async () => {
  await page.click('.toggle'); // Diffuse on
  await ask('Show me diffusion #slow'); // slowed down, so the steps can be watched
  await page.waitForSelector('.canvas .canvas-text', { timeout: 10_000 });
  const first = await textOf('.canvas-meter');
  await sleep(500);
  const second = await textOf('.canvas-meter');
  const fresh = await count('.canvas-fresh');
  await shot('06-diffusion');
  assert(/step \d+/.test(first) && Number(second.match(/\d+/)?.[0]) > Number(first.match(/\d+/)?.[0]), `steps advance: ${first} → ${second}`);
  assert(fresh >= 1, 'freshly settled words are highlighted');
  await waitForAnswers(4);
  assert((await count('.canvas')) === 0, 'canvas replaced by the typeset answer');
  const colophon = (await page.$$eval('.colophon-meta', (els) => els.at(-1)?.textContent ?? '')) ?? '';
  assert(/\d+ steps/.test(colophon), `colophon counts steps: ${colophon}`);
  assert(chats().at(-1)?.diffusing === true, 'diffusing sent');
  await page.click('.toggle'); // off again
  await page.click('.modes .mode:nth-child(3)'); // Medium
});

await step('stops a stream on request and keeps what arrived', async () => {
  await ask('Tell me a long story #slow');
  await page.waitForSelector('.send-button--stop', { timeout: 10_000 });
  await page.waitForFunction(() => {
    const turns = document.querySelectorAll('.turn--assistant');
    return (turns[turns.length - 1]?.querySelector('.prose')?.textContent?.length ?? 0) > 20;
  });
  await page.click('.send-button--stop');
  await waitForAnswers(5);
  assert((await count('.stopped-mark')) === 1, 'stopped marker shown');
});

await step('shows a stream error with a retry', async () => {
  await ask('Please fail #error');
  await waitForAnswers(6);
  const note = await textOf('.error-note');
  assert(note.includes('Simulated upstream failure'), `error note: ${note}`);
});

await step('backs off and recovers from rate limiting on its own', async () => {
  await page.click('.new-chat');
  await page.waitForSelector('.masthead');
  await ask('Busy server #429');
  await page.waitForSelector('.status-line--retry', { timeout: 5_000 });
  assert((await textOf('.status-line--retry')).includes('rate-limiting'), 'backoff explained while waiting');
  await waitForAnswers(1, 40_000);
  assert((await textOf('.turn--assistant')).includes('End of the simulated answer.'), 'answer arrives after the retries');
  assert(mock.state.log.filter((l) => l.status === 429).length === 2, 'two 429s absorbed');
});

await step('persists conversations; the saved key restarts the session on reload', async () => {
  const before = chats('handshake').length;
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForSelector('.status-pill[data-tone="ok"]', { timeout: 10_000 });
  assert(chats('handshake').length === before + 1, 'a fresh handshake on start');
  await page.waitForFunction(() => document.querySelectorAll('.list-item').length === 2, { timeout: 10_000 });
  await page.click('.list-item:nth-of-type(2) .list-title');
  await page.waitForSelector('.exchange');
  assert((await count('.exchange')) === 6, `all exchanges restored, got ${await count('.exchange')}`);
  assert((await count('.error-note')) === 1 && (await count('.stopped-mark')) === 1, 'statuses restored');
});

await step('night theme and settings sheet', async () => {
  await page.$eval('.scroller', (el) => el.scrollTo(0, 0));
  await page.click('.topbar-actions .icon-button[aria-label^="Switch to night"]');
  await page.waitForFunction(() => document.documentElement.dataset.theme === 'night');
  await sleep(350);
  await shot('07-night');
  await page.click('.topbar-actions .icon-button[aria-label="Settings"]');
  await page.waitForSelector('.sheet[data-open="true"]');
  await sleep(400);
  await shot('08-settings');
  const facts = await textOf('.facts');
  assert(facts.includes('test…') || facts.includes('••••'), `masked key shown: ${facts}`);
  await page.keyboard.press('Escape');
  await page.click('.topbar-actions .icon-button[aria-label^="Switch to paper"]');
});

await step('mobile layout', async () => {
  await page.setViewport({ width: 390, height: 844, deviceScaleFactor: 2 });
  await sleep(300);
  await shot('09-mobile');
  await page.click('.menu-button');
  await page.waitForSelector('.sidebar[data-open="true"]');
  await sleep(350);
  await shot('10-mobile-sidebar');
  await page.click('.sidebar-close');
  await page.setViewport({ width: 1440, height: 940, deviceScaleFactor: 1 });
});

await step('an account without credit is explained, with the ways out', async () => {
  await page.evaluate(() => localStorage.setItem('inception-direct.api-key.v1', 'broke-key'));
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForSelector('.notice[data-tone="bad"]', { timeout: 10_000 });
  assert((await textOf('.notice-title')).includes('needs credit'), 'billing notice');
  assert((await textOf('.status-pill')).includes('No credit'), 'status: no credit');
  await sleep(250);
  await shot('11-billing');
  await clickText('.notice-actions .button', 'Use another key', { prefix: true });
  await enterKey('test-key');
  await page.waitForSelector('.status-pill[data-tone="ok"]', { timeout: 10_000 });
});

await step('forgetting the key returns to the key card', async () => {
  await page.click('.topbar-actions .icon-button[aria-label="Settings"]');
  await page.waitForSelector('.sheet[data-open="true"]');
  await clickText('.sheet .button', 'Forget key', { prefix: true });
  await clickText('.sheet .button', 'Forget it');
  await page.keyboard.press('Escape');
  await page.waitForSelector('.key-card');
  assert((await page.evaluate(() => localStorage.getItem('inception-direct.api-key.v1'))) === null, 'key erased');
  assert((await textOf('.status-pill')).includes('Add key'), 'status back to “Add key”');
});

await step('no unexpected errors were logged by the page', async () => {
  // 401/402/429 responses are part of the script above; the browser logs them as failed loads.
  const unexpected = pageErrors.filter((e) => !/status of 4\d\d|Failed to load resource/.test(e));
  assert(unexpected.length === 0, `page errors:\n${unexpected.join('\n')}`);
});

await step('production build: strict CSP — and it still streams straight from the API', async () => {
  const outDir = mkdtempSync(join(tmpdir(), 'inception-direct-dist-'));
  try {
    await build({ root, configFile: `${root}vite.config.ts`, logLevel: 'error', build: { outDir, emptyOutDir: true } });
    const server = await preview({ root, configFile: `${root}vite.config.ts`, logLevel: 'error', build: { outDir }, preview: { host: '127.0.0.1', port: 4391, strictPort: false } });
    const url = server.resolvedUrls?.local[0] ?? 'http://127.0.0.1:4391/';
    const p = await browser.newPage();
    await p.setViewport({ width: 1280, height: 900 });
    await p.evaluateOnNewDocument(() => {
      /** @type {any} */ (window).__violations = [];
      document.addEventListener('securitypolicyviolation', (e) => /** @type {any} */ (window).__violations.push(`${e.violatedDirective} ${e.blockedURI}`));
    });
    await p.goto(url, { waitUntil: 'domcontentloaded' });
    const csp = await p.$eval('meta[http-equiv="Content-Security-Policy"]', (el) => el.getAttribute('content') ?? '');
    assert(csp.includes(`connect-src 'self' ${new URL(mock.url).origin}`) && csp.includes("script-src 'self'"), `csp: ${csp}`);
    await p.waitForFunction(() => document.fonts.status === 'loaded');
    await enterKey('test-key', p);
    await p.waitForSelector('.status-pill[data-tone="ok"]', { timeout: 10_000 });
    await ask('Production check', p);
    await waitForAnswers(1, 30_000, p);
    assert((await textOf('.prose', p)).includes('End of the simulated answer.'), 'answer streamed in the production build');
    assert((await p.$$eval('.prose .katex', (els) => els.length)) >= 2, 'maths renders under the CSP');
    const exfil = await p.evaluate(() => fetch('https://example.com/steal').then(() => 'sent', () => 'blocked'));
    assert(exfil === 'blocked', 'requests to any other host are blocked by the CSP');
    const violations = await p.evaluate(() => /** @type {any} */ (window).__violations);
    assert(violations.length === 1 && violations[0].startsWith('connect-src https://example.com'), `only the deliberate violation: ${JSON.stringify(violations)}`);
    await p.close();
    await server.close();
  } finally {
    rmSync(outDir, { recursive: true, force: true });
  }
});

await browser.close();
await dev.close();
await mock.close();

console.log(`\nBrowser end-to-end (${failures ? 'FAILED' : 'passed'}):\n${results.join('\n')}\n\nScreenshots: ${shots}`);
process.exit(failures ? 1 : 0);
