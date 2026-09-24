#!/usr/bin/env node
/**
 * ══════════════════════════════════════════════════════════════════
 *  npm run doctor — does the reverse-engineered access actually work?
 * ══════════════════════════════════════════════════════════════════
 *
 *  Runs on YOUR machine (where api.deepinfra.com is reachable) and
 *  probes the endpoint with each header variant we care about, in a
 *  real Node process — so Origin / Referer / User-Agent really go out
 *  on the wire.
 *
 *      node scripts/doctor.mjs
 *      node scripts/doctor.mjs --key=di_xxxxxxxx
 *
 *  Probes
 *    1. keyless + g4f.dev origin      (the older Python provider's set)
 *    2. keyless + deepinfra.com origin + X-Deepinfra-Source: web-embed
 *    3. keyed   + deepinfra.com origin + X-Deepinfra-Source: web-embed
 *    4. GET /v1/openai/models  (keyless and keyed)
 *
 *  Exit code 0 if any chat probe succeeds.
 */

import https from 'node:https'

const KEY = (process.argv.find((a) => a.startsWith('--key=')) || '').split('=')[1] || ''
const HOST = 'api.deepinfra.com'
const MODEL = process.env.DOCTOR_MODEL || 'Qwen/Qwen3-Max'
const PROMPT = 'Reply with exactly one word: ok'

const C = {
  reset: '\x1b[0m', dim: '\x1b[2m', bold: '\x1b[1m',
  green: '\x1b[32m', red: '\x1b[31m', yellow: '\x1b[33m', cyan: '\x1b[36m',
}

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/145.0.0.0 Safari/537.36'

function headerSets(apiKey) {
  const base = {
    'Content-Type': 'application/json',
    'Accept': 'text/event-stream',
    'Accept-Language': 'en-US,en;q=0.9',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
    'User-Agent': UA,
  }
  const out = []
  out.push({
    label: 'g4f.dev origin (older Python DeepInfra.py set)',
    headers: {
      ...base,
      Origin: 'https://g4f.dev',
      Referer: 'https://g4f.dev',
      'sec-ch-ua': '"Not:A-Brand";v="99", "Google Chrome";v="145", "Chromium";v="145"',
      'sec-ch-ua-mobile': '?0',
      'sec-ch-ua-platform': '"Windows"',
      'x-request-id': 'Ry3LRoEwEsPHJxUrUrYpfCzm',
      ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
    },
  })
  out.push({
    label: 'deepinfra.com origin + X-Deepinfra-Source: web-embed (g4f DeepInfraChat set)',
    headers: {
      ...base,
      Origin: 'https://deepinfra.com',
      Referer: 'https://deepinfra.com/',
      'Sec-Fetch-Dest': 'empty',
      'Sec-Fetch-Mode': 'cors',
      'Sec-Fetch-Site': 'same-site',
      'X-Deepinfra-Source': 'web-embed',
      Pragma: 'no-cache',
      ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
    },
  })
  return out
}

function request({ method, path, headers, body, collectMs = 2500 }) {
  return new Promise((resolve) => {
    const started = Date.now()
    const req = https.request({ host: HOST, path, method, headers }, (res) => {
      const chunks = []
      let firstByteAt = null
      res.on('data', (c) => {
        if (firstByteAt === null) firstByteAt = Date.now()
        chunks.push(c)
        if (Date.now() - started > collectMs) res.destroy()
      })
      res.on('close', () =>
        resolve({
          status: res.statusCode ?? 0,
          headers: res.headers,
          body: Buffer.concat(chunks).toString('utf8'),
          ttfbMs: firstByteAt ? firstByteAt - started : null,
          totalMs: Date.now() - started,
        }),
      )
      res.on('error', () =>
        resolve({
          status: res.statusCode ?? 0,
          headers: res.headers,
          body: Buffer.concat(chunks).toString('utf8'),
          ttfbMs: firstByteAt ? firstByteAt - started : null,
          totalMs: Date.now() - started,
        }),
      )
    })
    req.setTimeout(20_000, () => req.destroy(new Error('timeout after 20s')))
    req.on('error', (err) =>
      resolve({ status: 0, headers: {}, body: '', error: err.message, totalMs: Date.now() - started }),
    )
    if (body) req.write(body)
    req.end()
  })
}

function firstTokens(body, n = 2) {
  return body
    .split('\n')
    .filter((l) => l.startsWith('data:'))
    .slice(0, n)
    .map((l) => l.slice(5).trim())
    .join('  ')
}

function verdict(status, body) {
  if (status === 200) return `${C.green}WORKS — 200 OK${C.reset}`
  if (status === 401) return `${C.red}401 — needs an API key${C.reset}`
  if (status === 403) return `${C.red}403 — blocked (origin/UA rejected)${C.reset}`
  if (status === 404) return `${C.yellow}404 — model id not served${C.reset}`
  if (status === 429) return `${C.yellow}429 — rate limited (keyless quota)${C.reset}`
  if (status === 0) return `${C.red}no answer${C.reset}`
  if (status >= 500) return `${C.yellow}${status} — upstream/edge error, retryable${C.reset}`
  return `${C.yellow}${status}${C.reset}`
}

const line = '─'.repeat(74)
console.log(`\n${C.bold}🔷 DeepInfra access doctor${C.reset}`)
console.log(line)
console.log(`  host      : https://${HOST}`)
console.log(`  model     : ${MODEL}`)
console.log(`  api key   : ${KEY ? `${C.cyan}provided via --key${C.reset}` : 'none (anonymous probes)'}`)
console.log(`  node      : ${process.version}`)
console.log(line)

let anyOk = false

for (const variant of headerSets(KEY)) {
  const payload = JSON.stringify({
    model: MODEL,
    messages: [{ role: 'user', content: PROMPT }],
    stream: true,
    max_tokens: 16,
  })
  const res = await request({
    method: 'POST',
    path: '/v1/openai/chat/completions',
    headers: { ...variant.headers, 'Content-Length': Buffer.byteLength(payload) },
    body: payload,
  })

  console.log(`\n${C.bold}▸ POST /v1/openai/chat/completions${C.reset}`)
  console.log(`  headers : ${variant.label}`)
  console.log(`  status  : ${res.status}   ${verdict(res.status, res.body)}`)
  if (res.ttfbMs != null) console.log(`  ttfb    : ${res.ttfbMs} ms   (upstream first byte)`)
  if (res.headers['content-type']) console.log(`  type    : ${res.headers['content-type']}`)
  if (res.error) console.log(`  error   : ${res.error}`)
  if (res.body) console.log(`  ${C.dim}body    : ${firstTokens(res.body, 2).slice(0, 300) || res.body.slice(0, 300)}${C.reset}`)

  if (res.status === 200 && /^data:/m.test(res.body)) anyOk = true
}

// ── model catalogue ──────────────────────────────────────────────────
for (const withKey of KEY ? [false, true] : [false]) {
  const res = await request({
    method: 'GET',
    path: '/v1/openai/models',
    headers: {
      Accept: 'application/json',
      'User-Agent': UA,
      Origin: 'https://deepinfra.com',
      Referer: 'https://deepinfra.com/',
      ...(withKey ? { Authorization: `Bearer ${KEY}` } : {}),
    },
    collectMs: 4000,
  })
  console.log(`\n${C.bold}▸ GET /v1/openai/models${C.reset}  ${withKey ? '(keyed)' : '(keyless)'}`)
  console.log(`  status  : ${res.status}   ${verdict(res.status, res.body)}`)
  if (res.status === 200) {
    try {
      const json = JSON.parse(res.body)
      const ids = (json.data || []).map((m) => m.id)
      console.log(`  models  : ${ids.length} available`)
      console.log(`  ${C.dim}sample  : ${ids.slice(0, 5).join(', ')}${C.reset}`)
    } catch {
      console.log(`  ${C.dim}body    : ${res.body.slice(0, 200)}${C.reset}`)
    }
  } else if (res.body) {
    console.log(`  ${C.dim}body    : ${res.body.slice(0, 200)}${C.reset}`)
  }
}

console.log(`\n${line}`)
if (anyOk) {
  console.log(`${C.green}${C.bold}✔ At least one probe streamed successfully.${C.reset}`)
  console.log('  Open the app (npm run dev) — Auto mode will pick the working rung.')
} else {
  console.log(`${C.red}${C.bold}✘ No probe returned a stream.${C.reset}`)
  console.log('  • 401 everywhere → anonymous access is closed; set a key:')
  console.log('      npm run doctor -- --key=<your DeepInfra key>   (then put it in the app Settings)')
  console.log('  • 403 → the origin/UA set is being rejected, tell me and we refresh the headers.')
  console.log('  • status 0 → your network/DNS blocks api.deepinfra.com.')
}
console.log(line + '\n')

process.exit(anyOk ? 0 : 1)
