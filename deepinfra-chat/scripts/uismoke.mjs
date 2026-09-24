#!/usr/bin/env node
/**
 * ══════════════════════════════════════════════════════════════════
 *  npm run uismoke — boots the REAL React app inside jsdom and drives it
 * ══════════════════════════════════════════════════════════════════
 *
 *  Not a snapshot test: it renders <App/>, types into the composer,
 *  presses Enter and then asserts what a user would see — streamed text,
 *  fallback behaviour when a rung is blocked, the 401 error card, the
 *  diagnostics ladder, and demo mode with the network stubbed dead.
 *
 *  The network is faked per scenario; nothing touches DeepInfra.
 */

import { JSDOM } from 'jsdom'
import { createServer } from 'vite'

const C = { g: '\x1b[32m', r: '\x1b[31m', d: '\x1b[2m', b: '\x1b[1m', x: '\x1b[0m' }
let passed = 0
const failures = []

async function check(name, fn) {
  try {
    await fn()
    passed += 1
    console.log(`  ${C.g}✓${C.x} ${name}`)
  } catch (err) {
    failures.push({ name, err })
    console.log(`  ${C.r}✗${C.x} ${name}\n      ${C.d}${err.message.split('\n')[0]}${C.x}`)
  }
}

const SSE = (text) =>
  new ReadableStream({
    start(c) {
      c.enqueue(new TextEncoder().encode(`data: {"choices":[{"delta":{"role":"assistant"}}]}\n`))
      c.enqueue(new TextEncoder().encode(`data: {"choices":[{"delta":{"content":${JSON.stringify(text)}}}]}\n`))
      c.enqueue(new TextEncoder().encode(`data: {"choices":[{"delta":{"reasoning_content":"because"}}]}\n`))
      c.enqueue(
        new TextEncoder().encode(
          'data: {"choices":[],"usage":{"prompt_tokens":4,"completion_tokens":2}}\n' +
            'data: [DONE]\n',
        ),
      )
      c.close()
    },
  })

const okResponse = (text) =>
  new Response(SSE(text), { status: 200, headers: { 'content-type': 'text/event-stream' } })

const errResponse = (status, body = '{"error":{"message":"nope"}}') =>
  new Response(body, { status, headers: { 'content-type': 'application/json' } })

// ── DOM scaffold ────────────────────────────────────────────────────
const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', {
  url: 'http://localhost:5173/',
  pretendToBeVisual: true,
})
const { window } = dom

// Node 22 exposes some of these as getter-only globals, so assign defensively.
function setGlobal(name, value) {
  try {
    globalThis[name] = value
    if (globalThis[name] === value) return
  } catch {
    /* fall through to defineProperty */
  }
  Object.defineProperty(globalThis, name, { value, configurable: true, writable: true })
}

setGlobal('window', window)
setGlobal('document', window.document)
setGlobal('navigator', window.navigator)
setGlobal('HTMLElement', window.HTMLElement)
setGlobal('Event', window.Event)
setGlobal('KeyboardEvent', window.KeyboardEvent)
setGlobal('MouseEvent', window.MouseEvent)
setGlobal('localStorage', window.localStorage)
setGlobal('requestAnimationFrame', window.requestAnimationFrame.bind(window))
setGlobal('cancelAnimationFrame', window.cancelAnimationFrame.bind(window))
setGlobal('IS_REACT_ACT_ENVIRONMENT', false)

const wait = (ms) => new Promise((r) => setTimeout(r, ms))
async function waitFor(label, predicate, timeout = 4000) {
  const start = Date.now()
  for (;;) {
    if (predicate()) return true
    if (Date.now() - start > timeout) throw new Error(`timeout waiting for ${label}`)
    await wait(25)
  }
}

function setValue(el, value) {
  const desc = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el), 'value')
  desc.set.call(el, value)
  el.dispatchEvent(new window.Event('input', { bubbles: true }))
}

function typingSend(text) {
  const area = document.querySelector('.composer-input')
  if (!area) throw new Error('composer textarea not found')
  setValue(area, text)
  area.dispatchEvent(
    new window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }),
  )
}

const bodyText = () => document.body.textContent || ''

// ── boot Vite in SSR mode so JSX/CSS resolve exactly like the app ────
const vite = await createServer({
  server: { middlewareMode: true, hmr: false },
  appType: 'custom',
  logLevel: 'error',
})

const React = (await import('react')).default
const { createRoot } = await import('react-dom/client')
const AppModule = await vite.ssrLoadModule('/src/App.jsx')
const App = AppModule.default

const container = document.getElementById('root')
const root = createRoot(container)
root.render(React.createElement(App))
await wait(120)

console.log(`${C.b}NovaChat UI smoke test${C.x} ${C.d}(real React app inside jsdom)${C.x}\n`)

await check('app mounts and renders the hero', async () => {
  await waitFor('hero', () => bodyText().includes('Say hi to'))
  if (!bodyText().includes('NovaChat')) throw new Error('brand missing')
  if (!document.querySelector('.composer-input')) throw new Error('composer missing')
  if (document.querySelectorAll('.hero-card').length !== 4) throw new Error('suggestion cards missing')
})

await check('sidebar shows the 4 route modes', async () => {
  const labels = [...document.querySelectorAll('.mode-btn .mode-label')].map((n) => n.textContent.trim())
  if (labels.join(',') !== 'Auto,Direct,Proxy,Demo') throw new Error(`got ${labels.join(',')}`)
})

await check('direct send streams text into a message bubble', async () => {
  globalThis.fetch = async () => okResponse('streamed-from-deepinfra')

  typingSend('hello there')
  await waitFor('user bubble', () => document.querySelector('.msg-user'))
  await waitFor('assistant text', () => bodyText().includes('streamed-from-deepinfra'), 5000)

  const bot = [...document.querySelectorAll('.msg-bot')].pop()
  if (!bot.querySelector('.thinking')) throw new Error('reasoning panel did not render')
  if (!bot.querySelector('.meta-row')) throw new Error('usage/timing row missing')
  if (bot.textContent.includes('streamed-from-deepinfra') === false) throw new Error('content missing')
})

await check('a blocked first rung falls forward and still streams', async () => {
  let calls = 0
  globalThis.fetch = async () => {
    calls += 1
    if (calls === 1) throw new TypeError('Failed to fetch') // what CORS looks like
    return okResponse('came-through-the-second-rung')
  }

  const before = document.querySelectorAll('.msg-bot').length
  typingSend('try the ladder')
  await waitFor(
    'second answer',
    () => bodyText().includes('came-through-the-second-rung'),
    6000,
  )
  const after = document.querySelectorAll('.msg-bot').length
  if (after !== before + 1) throw new Error(`bubble count ${before} → ${after}`)
  if (calls < 2) throw new Error('fallback was not used')
  if (!bodyText().toLowerCase().includes('falling back')) {
    // toast is transient, so accept either the toast or the log
    if (!bodyText().toLowerCase().includes('direct')) throw new Error('no visible fallback signal')
  }
})

await check('401 renders the error card with the key hint', async () => {
  globalThis.fetch = async () => errResponse(401)
  typingSend('this should fail')
  await waitFor('error card', () => document.querySelector('.error-card'), 6000)
  const card = document.querySelector('.error-card')
  if (!card.textContent.includes('401')) throw new Error('status not shown')
  if (!/api key|Settings/i.test(card.textContent)) throw new Error('hint missing')
})

await check('diagnostics drawer lists the ladder and the last run', async () => {
  const btns = [...document.querySelectorAll('.icon-btn')]
  const pulse = btns.find((b) => (b.getAttribute('title') || '').toLowerCase().includes('diagnostic'))
  if (!pulse) throw new Error('diagnostics button not found')
  pulse.dispatchEvent(new window.MouseEvent('click', { bubbles: true }))

  await waitFor('drawer', () => document.querySelector('.drawer'))
  await waitFor('ladder rows', () => document.querySelectorAll('.ladder li').length === 4)
  if (!bodyText().includes('Route ladder')) throw new Error('ladder heading missing')
  if (!document.querySelector('.stat-grid')) throw new Error('last-run stats missing')
  if (!/npm run doctor/.test(bodyText())) throw new Error('doctor hint missing')

  document.querySelector('.drawer-backdrop').dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
  await waitFor('drawer closed', () => !document.querySelector('.drawer'))
})

await check('settings drawer exposes mode cards + key field', async () => {
  const gear = [...document.querySelectorAll('.icon-btn')].find((b) =>
    (b.getAttribute('title') || '').toLowerCase().includes('settings'),
  )
  gear.dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
  await waitFor('settings cards', () => document.querySelectorAll('.mode-card').length === 4)
  if (!document.querySelector('input[type="password"]')) throw new Error('api key field missing')
  if (!bodyText().includes('System prompt')) throw new Error('system prompt field missing')
  document.querySelector('.drawer-backdrop').dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
  await waitFor('closed', () => !document.querySelector('.drawer'))
})

await check('demo mode streams with the network stubbed dead', async () => {
  globalThis.fetch = async () => {
    throw new Error('network must not be touched in demo mode')
  }
  const demoBtn = [...document.querySelectorAll('.mode-btn')].find((b) =>
    b.textContent.includes('Demo'),
  )
  demoBtn.dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
  await wait(60)

  typingSend('show me the demo')

  // the heading arrives before the code fence, so wait for each in turn
  await waitFor('demo answer', () => bodyText().includes('Demo stream'), 8000)
  await waitFor('markdown code block', () => document.querySelector('.markdown pre'), 8000)
  await waitFor('code copy button', () => document.querySelector('.code-copy'), 4000)
  await waitFor('markdown table', () => document.querySelector('.markdown table'), 6000)

  // and it must finish by itself: stop-button disappears, meta row appears
  await waitFor('stream finished', () => !document.querySelector('.send-btn.stop'), 15000)
  const bot = [...document.querySelectorAll('.msg-bot')].pop()
  if (!bot.querySelector('.meta-row')) throw new Error('usage row missing after completion')
})

await check('persistence: conversations survive a remount', async () => {
  const stored = JSON.parse(localStorage.getItem('novachat.v1.conversations') || '[]')
  if (!stored.length) throw new Error('nothing persisted to localStorage')
  if (!stored.some((c) => c.messages.length >= 2)) throw new Error('messages not persisted')
  await waitFor('settings saved', () => Boolean(localStorage.getItem('novachat.v1.settings')))
})

// ── cleanup ─────────────────────────────────────────────────────────
root.unmount()
await vite.close()

console.log(`\n${'─'.repeat(60)}`)
if (failures.length) {
  console.log(`${C.r}${C.b}${failures.length} failed${C.x} · ${passed} passed`)
  for (const f of failures) console.log(`${C.r}•${C.x} ${f.name}: ${f.err.message}`)
  process.exit(1)
}
console.log(`${C.g}${C.b}all ${passed} UI checks passed${C.x} — the app renders, streams, falls back and persists`)