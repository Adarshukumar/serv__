// @ts-check
/**
 * Complete local-companion / dedicated Chromium / typed SSE / React UI test.
 * All answers below are from the STRICT LOCAL PROTOCOL SIMULATOR, NEVER the live
 * Inception site. The live site cannot be verified in this sandbox.
 *
 * Run with a local Chrome: CHROME_PATH=/path/to/chrome npm run test:e2e
 * No Chrome binary is shipped with the application. For CI, use an installed one.
 */
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer-core';
import { preview } from 'vite';
import { createCompanion } from '../../local/server.ts';
import { findChrome } from '../../local/site-browser.ts';
import { startMockInception } from '../fixtures/mock-inception.mjs';

const root = fileURLToPath(new URL('../..', import.meta.url));
const chromePath = process.env.CHROME_PATH || findChrome();
const work = mkdtempSync(join(tmpdir(), 'mercury-e2e-'));
const flags = (process.env.CHROME_ARGS ?? '--no-sandbox --disable-dev-shm-usage').split(/\s+/).filter(Boolean);
const screenshotDir = process.env.SCREENSHOTS;
if (screenshotDir) mkdirSync(screenshotDir, { recursive: true });
let mock, companion, browser, vitePreview, page;
const errors = [];
const steps = [];

async function step(name, fn) {
  const start = Date.now();
  await fn();
  steps.push(`${name} (${Date.now() - start} ms)`);
  console.log(`✓ ${steps.at(-1)}`);
}
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
async function shot(page, name) {
  if (screenshotDir) await page.screenshot({ path: join(screenshotDir, `${name}.png`) });
}
function listen(page, allowedOrigins) {
  page.on('pageerror', (e) => errors.push(`JS: ${e.message}`));
  page.on('request', (r) => {
    try {
      const url = new URL(r.url());
      if (url.protocol.startsWith('http') && !allowedOrigins.has(url.origin)) errors.push(`Unexpected browser request: ${r.url()}`);
    } catch { /* data/blob */ }
  });
}
async function status(page, label) {
  await page.waitForFunction((label) => document.querySelector('.status-pill .status-label')?.textContent === label, { timeout: 28_000 }, label);
}
async function ask(page, text) {
  await page.click('#composer-input');
  await page.type('#composer-input', text);
  await page.keyboard.press('Enter');
}
async function completed(page, n) {
  await page.waitForFunction((n) => {
    const turns = document.querySelectorAll('.turn--assistant');
    return turns.length >= n && turns[n - 1]?.querySelector('.colophon') !== null;
  }, { timeout: 40_000 }, n);
}
async function localPost(path, body, origin, token) {
  return fetch(companion.url + path, {
    method: 'POST', headers: { Origin: origin, 'x-mercury-local': token, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}
async function wrongHostStatus(url) {
  return new Promise((resolve, reject) => {
    http.get(url, { headers: { Host: 'evil.example' } }, (res) => {
      res.resume();
      res.on('end', () => resolve(res.statusCode));
    }).on('error', reject);
  });
}

try {
  // A hosted preview intentionally cannot obtain an Inception session from the
  // user's IP. Prove it shows setup instructions and makes no site/API calls.
  vitePreview = await preview({ root, configFile: join(root, 'vite.config.ts'), preview: { host: '127.0.0.1', port: 0, strictPort: false }, logLevel: 'error' });
  const previewAddress = vitePreview.httpServer.address();
  const hosted = `http://127.0.0.1:${previewAddress.port}`;
  browser = await puppeteer.launch({ executablePath: chromePath, headless: true, userDataDir: join(work, 'ui'), args: flags });
  page = await browser.newPage();
  page.setDefaultTimeout(10_000);
  await page.setViewport({ width: 1440, height: 940, deviceScaleFactor: 1 });
  const allowedOrigins = new Set([hosted]);
  listen(page, allowedOrigins);

  await step('hosted preview is honest and cannot send a fake chat message', async () => {
    await page.goto(hosted, { waitUntil: 'networkidle2' });
    await status(page, 'Preview only');
    const text = await page.$eval('.notice--preview', (el) => el.textContent ?? '');
    assert.match(text, /run it on your computer/i);
    assert.match(text, /npm start/);
    assert(await page.$eval('#composer-input', (el) => el.disabled));
    const csp = await page.$eval('meta[http-equiv="Content-Security-Policy"]', (el) => el.getAttribute('content'));
    assert.match(csp ?? '', /connect-src 'self'/);
    assert.doesNotMatch(csp ?? '', /api\.inceptionlabs/);
    await shot(page, 'hosted-preview');
  });

  mock = await startMockInception({ deltaDelayMs: 16, forceChallenge: true });
  companion = await createCompanion({
    siteUrl: mock.url, port: 0, distDir: join(root, 'dist'),
    browser: { chromePath, headless: true, userDataDir: join(work, 'site'), chromeArgs: flags },
  });
  const local = companion.url;
  allowedOrigins.add(local);

  await step('local server is loopback-only and guards all write routes', async () => {
    const raw = await fetch(local + '/_local/status');
    const data = await raw.json();
    assert.equal(data.mode, 'local');
    const secret = data.csrf;
    assert(typeof secret === 'string' && secret.length > 30);
    assert.equal((await localPost('/_local/connect', {}, local, 'wrong')).status, 403);
    assert.equal((await localPost('/_local/connect', {}, 'http://evil.invalid', secret)).status, 403);
    assert.equal(await wrongHostStatus(local + '/_local/status'), 403);
    assert.equal((await fetch(local + '/_local/connect')).status, 403);
    assert.equal((await localPost('/_local/chat', { chatId: 'bad', turns: [] }, local, secret)).status, 400);
    assert.equal((await fetch(local + '/package.json')).status, 404);
    assert.equal((await fetch(local + '/')).status, 200);
    assert.equal((await fetch(local + '/_local/status')).headers.get('access-control-allow-origin'), null);
  });

  // Reuse the UI page on the *different* localhost port. Each Chrome instance
  // has its OWN profile; the session belongs to the site Chrome, not this page.
  await page.goto(local, { waitUntil: 'domcontentloaded' });
  await step('dedicated site Chromium obtains a real simulator session and cookies', async () => {
    await status(page, 'Live');
    const siteCalls = mock.state.log;
    assert(siteCalls.some((e) => e.path === '/' && e.status === 200));
    assert(siteCalls.some((e) => e.path === '/api/session' && e.status === 200));
    const localStatus = await (await fetch(local + '/_local/status')).text();
    for (const token of mock.state.tokens.keys()) assert(!localStatus.includes(token), 'site token must never be returned to the UI');
    const appState = await page.$eval('.masthead', (el) => el.textContent ?? '');
    assert.match(appState, /this computer/);
    await shot(page, 'local-ready');
  });

  await step('real SSE deltas, thinking, sources and follow-ups reach the React UI', async () => {
    await ask(page, 'Why is the sky blue?');
    await page.waitForSelector('.turn--assistant[aria-busy="true"] .prose', { timeout: 10_000 });
    await completed(page, 1);
    const content = await page.$eval('.turn--assistant .prose', (el) => el.textContent ?? '');
    assert.match(content, /local protocol simulator/);
    assert.match(content, /नमस्ते 👋/);
    assert.match(content, /End of the simulated answer/);
    assert((await page.$$('.sources li')).length >= 2);
    assert((await page.$$('.thinking')).length > 0);
    await page.waitForSelector('.follow-ups button', { timeout: 10_000 });
    const request = mock.state.log.find((e) => e.path === '/api/chat' && e.status === 200);
    assert(request?.cookie?.includes('session='), 'site fetch must have the site browser cookie');
    assert.equal(request?.origin, mock.url, 'same-origin Chrome fetch from the site');
    await shot(page, 'streamed-answer');
  });

  await step('follow-up history and a 429 backoff stay on the site protocol', async () => {
    await ask(page, 'Please explain again #429');
    await completed(page, 2);
    const calls = mock.state.log.filter((e) => e.path === '/api/chat' && e.status === 429);
    assert.equal(calls.length, 2);
    assert.equal(mock.state.chats.at(-1)?.messages, 3);
    assert.equal(mock.state.chats.at(-1)?.reasoningEffort, 'medium');
  });

  await step('stop aborts a slow site stream and marks the partial reply stopped', async () => {
    const before = mock.state.abortedStreams;
    await ask(page, 'Keep going #slow');
    await page.waitForSelector('button[aria-label="Stop generating"]');
    await page.waitForSelector('.turn--assistant[aria-busy="true"] .prose');
    await page.click('button[aria-label="Stop generating"]');
    await page.waitForSelector('.turn--assistant .stopped-mark', { timeout: 10_000 });
    for (let i = 0; i < 30 && mock.state.abortedStreams === before; i++) await wait(100);
    assert(mock.state.abortedStreams > before, 'Stop must abort the upstream site request');
    assert((await page.$$('.turn--assistant')).length >= 3);
  });

  await step('a real site error event is shown as an error, not a pretend completion', async () => {
    await ask(page, 'Trigger #error now');
    await page.waitForSelector('.turn--assistant .error-note', { timeout: 30_000 });
    const text = await page.$eval('.turn--assistant:last-of-type .error-note', (el) => el.textContent ?? '').catch(async () => {
      return page.$$eval('.error-note', (els) => els.at(-1)?.textContent ?? '');
    });
    assert.match(text, /Simulated upstream failure/);
  });

  await step('a Vercel-style checkpoint waits for the human, then retries automatically', async () => {
    mock.setChallenge(true);
    await ask(page, 'After this checkpoint please continue');
    await status(page, 'Security check');
    assert(await page.$eval('#composer-input', (el) => el.disabled));
    assert.match(await page.$eval('.notice', (el) => el.textContent ?? ''), /site window/i);
    assert(mock.state.log.some((e) => e.path === '/api/chat' && e.status === 429));
    // A human would complete the site check. The simulator toggle stands in for
    // that action; the product never tries to solve it or fake a site response.
    mock.setChallenge(false);
    await status(page, 'Live');
    await page.waitForFunction(() => {
      const els = [...document.querySelectorAll('.turn--assistant')];
      return Boolean(els.at(-1)?.querySelector('.colophon'));
    }, { timeout: 40_000 });
    const answer = await page.$$eval('.turn--assistant .prose', (els) => els.at(-1)?.textContent ?? '');
    assert.match(answer, /After this checkpoint please continue/);
  });

  await step('settings, persisted history, and a previous API key migration work', async () => {
    await page.evaluate(() => localStorage.setItem('inception-direct.api-key.v1', 'old-key-must-be-erased'));
    await page.click('button[aria-label="Switch to night theme"]');
    assert.equal(await page.evaluate(() => document.documentElement.dataset.theme), 'night');
    await page.reload({ waitUntil: 'domcontentloaded' });
    await status(page, 'Live');
    assert.equal(await page.evaluate(() => localStorage.getItem('inception-direct.api-key.v1')), null);
    await page.waitForSelector('.conversation-list .list-item');
    await page.click('.conversation-list .list-title');
    await page.waitForSelector('.turn--assistant');
    assert((await page.$$('.turn--assistant')).length >= 1);
    assert.equal(await page.evaluate(() => document.documentElement.dataset.theme), 'night');
  });

  await step('no UI request reached any other host or produced an uncaught browser error', async () => {
    await wait(50);
    assert.deepEqual(errors, []);
    const raw = await (await fetch(local + '/_local/status')).text();
    for (const token of mock.state.tokens.keys()) assert(!raw.includes(token), 'no site token in local status');
  });

  console.log(`\n${steps.length} Chromium end-to-end checks passed (SIMULATOR, not live Inception).`);
} catch (e) {
  console.error('\nE2E failed:', e);
  if (page && !page.isClosed()) console.error('Last UI state:', await page.evaluate(() => ({
    status: document.querySelector('.status-pill')?.textContent,
    lastAnswer: [...document.querySelectorAll('.turn--assistant')].at(-1)?.textContent?.slice(0, 340),
    busy: [...document.querySelectorAll('.turn--assistant')].at(-1)?.getAttribute('aria-busy'),
  })).catch(() => 'could not read page'));
  if (mock) console.error('Site calls:', mock.state.log.slice(-16));
  if (errors.length) console.error('Page errors / unexpected calls:', errors.slice(-8));
  process.exitCode = 1;
} finally {
  await browser?.close().catch(() => {});
  await companion?.close().catch(() => {});
  await mock?.close().catch(() => {});
  await new Promise((r) => vitePreview?.httpServer.close(() => r(undefined)) ?? r(undefined));
  rmSync(work, { force: true, recursive: true });
}
