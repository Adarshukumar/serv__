#!/usr/bin/env node
/**
 * ══════════════════════════════════════════════════════════════════
 *  npm run selftest — offline proof that the client logic is correct
 * ══════════════════════════════════════════════════════════════════
 *
 *  Everything here runs in plain Node (no browser, no network to DeepInfra):
 *    1. model resolution           (parity with _resolve() in DeepInfra.py)
 *    2. route-ladder planning
 *    3. SSE framing across chunk boundaries
 *    4. delta extraction (content / reasoning_content / usage)
 *    5. inline <think> routing
 *    6. transports end-to-end through a stubbed fetch:
 *         • happy stream
 *         • 429 then 200 (retry + backoff)
 *         • browser CORS failure → next rung succeeds (the fallback ladder)
 *         • 401 → fatal, no retry
 *    7. the local proxy, pointed at a mock upstream over http:
 *         • injects the web-embed / legacy header sets
 *         • streams SSE through untouched
 *         • /health answers
 */

import http from 'node:http'
import { strict as assert } from 'node:assert'

process.env.DEEPINFRA_PROXY_SCHEME = 'http' // set before importing the proxy

const { resolveModel, ALIASES, DEFAULT_ALIAS } = await import('../src/lib/deepinfra/models.js')
const { planLadder, streamChat, MODES } = await import('../src/lib/deepinfra/transport.js')
const { SSEParser, parseDelta, ThinkRouter } = await import('../src/lib/deepinfra/sse.js')
const { backoffMs, classifyHttpError } = await import('../src/lib/deepinfra/errors.js')
const { browserHeaders, FORBIDDEN_IN_BROWSER } = await import('../src/lib/deepinfra/headers.js')

const C = { g: '\x1b[32m', r: '\x1b[31m', y: '\x1b[33m', d: '\x1b[2m', b: '\x1b[1m', x: '\x1b[0m' }
let passed = 0
const failures = []

function test(name, fn) {
  try {
    fn()
    passed += 1
    console.log(`  ${C.g}✓${C.x} ${name}`)
  } catch (err) {
    failures.push({ name, err })
    console.log(`  ${C.r}✗${C.x} ${name}\n      ${C.d}${err.message}${C.x}`)
  }
}

async function testAsync(name, fn) {
  try {
    await fn()
    passed += 1
    console.log(`  ${C.g}✓${C.x} ${name}`)
  } catch (err) {
    failures.push({ name, err })
    console.log(`  ${C.r}✗${C.x} ${name}\n      ${C.d}${err.message}${C.x}`)
  }
}

function section(title) {
  console.log(`\n${C.b}${title}${C.x}`)
}

// ── fixtures ────────────────────────────────────────────────────────
const SSE_BODY =
  'data: {"choices":[{"delta":{"role":"assistant"},"index":0}]}\n' +
  'data: {"choices":[{"delta":{"content":"Hello"},"index":0}]}\n' +
  ': keep-alive\n' +
  'data: {"choices":[{"delta":{"reasoning_content":"weighing it"},"index":0}]}\n' +
  'data: {"choices":[{"delta":{"content":" world"},"index":0}]}\n' +
  'data: {"choices":[{"delta":{"content":"<think>inline reasoning</think>answer"},"index":0}]}\n' +
  'data: {"choices":[],"usage":{"prompt_tokens":11,"completion_tokens":7}}\n' +
  'data: [DONE]\n'

function sseResponse(body = SSE_BODY, { status = 200, headers = {} } = {}) {
  const stream = new ReadableStream({
    start(controller) {
      // deliberately split mid-frame to prove buffering
      const bytes = new TextEncoder().encode(body)
      for (let i = 0; i < bytes.length; i += 37) {
        controller.enqueue(bytes.slice(i, i + 37))
      }
      controller.close()
    },
  })
  return new Response(stream, {
    status,
    headers: { 'content-type': 'text/event-stream; charset=utf-8', ...headers },
  })
}

const realFetch = globalThis.fetch
const realRandom = Math.random
const realSetTimeout = globalThis.setTimeout

/** Make backoff instant so the retry tests stay fast. */
function speedUpTimers() {
  Math.random = () => 0.5
  globalThis.setTimeout = (fn) => {
    fn()
    return 0
  }
}
function restoreTimers() {
  Math.random = realRandom
  globalThis.setTimeout = realSetTimeout
}

// ══════════════════════════════════════════════════════════════════
console.log(`${C.b}NovaChat self-test${C.x}  ${C.d}(offline · no DeepInfra calls)${C.x}`)

section('1 · model resolution (parity with _resolve)')
test('alias → full id', () => assert.equal(resolveModel('kimi-k2.5'), 'moonshotai/Kimi-K2.5'))
test('case + whitespace tolerant', () => assert.equal(resolveModel('  GLM-5  '), 'zai-org/GLM-5'))
test('full id passes through', () => assert.equal(resolveModel('Qwen/Qwen3-Max'), 'Qwen/Qwen3-Max'))
test('unknown short name passes through (same quirk as Python)', () =>
  assert.equal(resolveModel('gpt-4o'), 'gpt-4o'))
test('empty → default alias id', () => assert.equal(resolveModel(''), ALIASES[DEFAULT_ALIAS]))
test('catalogue default exists', () => assert.ok(ALIASES[DEFAULT_ALIAS]))

section('2 · route ladder')
test('auto = direct×2 then proxy×2', () =>
  assert.deepEqual(
    planLadder({ mode: 'auto' }).map((r) => r.id),
    ['direct-webembed', 'direct-minimal', 'proxy-web-embed', 'proxy-legacy'],
  ))
test('direct mode never touches the proxy', () =>
  assert.deepEqual(planLadder({ mode: 'direct' }).map((r) => r.kind), ['direct', 'direct']))
test('proxy mode is proxy-only', () =>
  assert.deepEqual(planLadder({ mode: 'proxy' }).map((r) => r.kind), ['proxy', 'proxy']))
test('demo mode is a single offline rung', () =>
  assert.deepEqual(planLadder({ mode: 'demo' }).map((r) => r.id), ['demo']))
test('all four modes exist', () => assert.equal(MODES.length, 4))

section('3 · SSE framing')
test('splits frames across chunk boundaries', () => {
  const p = new SSEParser()
  const out = [...p.push('data: {"a":'), ...p.push('1}\ndata: {"b":2}\n')]
  assert.equal(out.length, 2)
  assert.equal(out[1].data, '{"b":2}')
})
test('ignores comments and non-data lines', () => {
  const p = new SSEParser()
  assert.equal(p.push(': ping\nevent: x\n\n').length, 0)
})
test('handles CRLF', () => {
  const p = new SSEParser()
  assert.equal(p.push('data: {"c":3}\r\n')[0].data, '{"c":3}')
})
test('[DONE] is reported', () => assert.equal(parseDelta('[DONE]').done, true))

section('4 · delta extraction')
test('content', () => assert.equal(parseDelta('{"choices":[{"delta":{"content":"hi"}}]}').content, 'hi'))
test('reasoning_content', () =>
  assert.equal(parseDelta('{"choices":[{"delta":{"reasoning_content":"hmm"}}]}').reasoning, 'hmm'))
test('usage survives (the Python file threw this away)', () => {
  const d = parseDelta('{"choices":[],"usage":{"prompt_tokens":5,"completion_tokens":2}}')
  assert.equal(d.usage.completion_tokens, 2)
})
test('role-only frame yields nothing', () => assert.equal(parseDelta('{"choices":[{"delta":{"role":"assistant"}}]}').content, ''))
test('garbage is ignored, not fatal', () => assert.equal(parseDelta('{not json').content, ''))
test('error frame throws a readable error', () =>
  assert.throws(() => parseDelta('{"error":{"message":"nope"}}'), /nope/))

section('5 · inline <think> routing')
test('splits reasoning from content', () => {
  const r = new ThinkRouter()
  const out = r.push('<think>why</think>because')
  assert.equal(out.reasoning, 'why')
  assert.equal(out.content, 'because')
})
test('survives a tag split across chunks', () => {
  const r = new ThinkRouter()
  const a = r.push('hello <thi')
  const b = r.push('nk>deep</think> end')
  assert.equal((a.content + b.content).replace(/\s+/g, ' ').trim(), 'hello end')
  assert.equal(b.reasoning, 'deep')
})
test('plain text is untouched', () => {
  const r = new ThinkRouter()
  assert.deepEqual(r.push('just text'), { content: 'just text', reasoning: '' })
})

section('6 · retry policy')
test('backoff starts at ~2 s and grows', () => {
  const b0 = backoffMs(0)
  const b2 = backoffMs(2)
  assert.ok(b0 >= 2000 && b0 < 3000, `b0=${b0}`)
  assert.ok(b2 >= 8000 && b2 < 9000, `b2=${b2}`)
})
test('backoff is capped at 30 s', () => assert.equal(backoffMs(10), 30000))
test('401 → auth, not retryable', () => {
  const e = classifyHttpError(401, '{"error":"no key"}', 'rung')
  assert.equal(e.kind, 'auth')
  assert.equal(e.retryable, false)
})
test('429 → retryable rate error', () => assert.equal(classifyHttpError(429, 'x', 'r').retryable, true))
test('404 → model error', () => assert.equal(classifyHttpError(404, 'x', 'r').kind, 'model'))
test('502 → upstream, retryable', () => assert.equal(classifyHttpError(502, 'x', 'r').kind, 'upstream'))

section('7 · browser header policy')
test('never sends forbidden headers', () => {
  const h = browserHeaders({ apiKey: 'k', webEmbed: true })
  for (const bad of FORBIDDEN_IN_BROWSER) {
    assert.ok(!(bad in h), `browserHeaders must not include ${bad}`)
  }
})
test('adds the web-embed marker when asked', () =>
  assert.equal(browserHeaders({ webEmbed: true })['X-Deepinfra-Source'], 'web-embed'))
test('adds Authorization only with a key', () => {
  assert.ok(!('Authorization' in browserHeaders({})))
  assert.equal(browserHeaders({ apiKey: 'di_x' }).Authorization, 'Bearer di_x')
})

// ══════════════════════════════════════════════════════════════════
await (async () => {
  section('8 · transport end-to-end (stubbed fetch)')

  const collect = () => {
    const acc = { content: '', reasoning: '', rungs: [], logs: [] }
    return {
      acc,
      onDelta: (c) => (acc.content += c),
      onReasoning: (c) => (acc.reasoning += c),
      onRung: (r) => acc.rungs.push(r.rung),
      onLog: (e) => acc.logs.push(e.text),
    }
  }

  await testAsync('happy path streams content, reasoning and usage', async () => {
    globalThis.fetch = async () => sseResponse()
    const spy = collect()
    const res = await streamChat({
      messages: [{ role: 'user', content: 'hi' }],
      model: 'zai-org/GLM-5',
      mode: 'direct',
      ...spy,
    })
    assert.equal(spy.acc.content, 'Hello worldanswer')
    assert.equal(res.reasoning, 'weighing itinline reasoning')
    assert.equal(res.usage.completion_tokens, 7)
    assert.equal(res.rung.kind, 'direct')
    assert.deepEqual(spy.acc.rungs, ['direct-webembed'])
  })

  await testAsync('429 is retried, then succeeds (sleep shortened)', async () => {
    let calls = 0
    globalThis.fetch = async () => {
      calls += 1
      if (calls === 1) {
        return new Response('{"error":"slow down"}', {
          status: 429,
          headers: { 'content-type': 'application/json' },
        })
      }
      return sseResponse()
    }
    speedUpTimers()
    const spy = collect()
    const res = await streamChat({
      messages: [{ role: 'user', content: 'hi' }],
      model: 'zai-org/GLM-5',
      mode: 'direct',
      retries: 2,
      ...spy,
    })
    restoreTimers()
    assert.equal(calls, 2, `expected 2 calls, saw ${calls}`)
    assert.equal(res.content, 'Hello worldanswer')
    assert.ok(spy.acc.logs.some((l) => /retry/.test(l)))
  })

  await testAsync('CORS failure on rung 1 falls forward to rung 2', async () => {
    const seen = []
    globalThis.fetch = async (url, init) => {
      seen.push({ url, marker: init.headers['X-Deepinfra-Source'] ?? null })
      if (seen.length === 1) throw new TypeError('Failed to fetch')
      return sseResponse()
    }
    const spy = collect()
    const res = await streamChat({
      messages: [{ role: 'user', content: 'hi' }],
      model: 'Qwen/Qwen3-Max',
      mode: 'auto',
      ...spy,
    })
    assert.equal(seen.length, 2)
    assert.equal(seen[0].marker, 'web-embed')
    assert.equal(seen[1].marker, null, 'second rung drops the custom header')
    assert.equal(res.rung.id, 'direct-minimal')
    assert.equal(res.attempts[0].ok, false)
    assert.equal(res.attempts[1].ok, true)
  })

  await testAsync('401 is fatal — no retry, error surfaced with a hint', async () => {
    let calls = 0
    globalThis.fetch = async () => {
      calls += 1
      return new Response('{"error":"unauthorized"}', {
        status: 401,
        headers: { 'content-type': 'application/json' },
      })
    }
    const spy = collect()
    await assert.rejects(
      streamChat({ messages: [], model: 'm', mode: 'direct', retries: 3, ...spy }),
      (err) => {
        assert.equal(err.kind, 'auth')
        assert.match(err.hint, /Settings|doctor/i)
        return true
      },
    )
    assert.equal(calls, 2, 'one call per direct rung, none retried')
  })

  await testAsync('all rungs failing yields a single "every route failed" error', async () => {
    globalThis.fetch = async () => {
      throw new TypeError('Failed to fetch')
    }
    await assert.rejects(
      streamChat({ messages: [], model: 'm', mode: 'auto', retries: 0, ...collect() }),
      (err) => {
        assert.equal(err.kind, 'exhausted')
        assert.equal(err.attempts.length, 4)
        return true
      },
    )
  })

  await testAsync('demo mode needs no fetch at all', async () => {
    globalThis.fetch = async () => {
      throw new Error('demo mode must not hit the network')
    }
    const spy = collect()
    const res = await streamChat({ messages: [], model: 'demo', mode: 'demo', ...spy })
    assert.ok(res.content.includes('Demo stream'))
    assert.equal(res.rung.kind, 'demo')
  })

  globalThis.fetch = realFetch

  // ════════════════════════════════════════════════════════════════
  section('9 · local proxy vs a mock upstream (real HTTP, real bytes)')

  const captured = []
  const upstream = http.createServer((req, res) => {
    const chunks = []
    req.on('data', (c) => chunks.push(c))
    req.on('end', () => {
      captured.push({
        path: req.url,
        method: req.method,
        headers: req.headers,
        body: Buffer.concat(chunks).toString('utf8'),
      })
      if (req.url.endsWith('/models')) {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ data: [{ id: 'zai-org/GLM-5' }, { id: 'Qwen/Qwen3-Max' }] }))
        return
      }
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      res.write('data: {"choices":[{"delta":{"content":"proxied"}}]}\n\n')
      res.write('data: [DONE]\n\n')
      res.end()
    })
  })
  await new Promise((r) => upstream.listen(0, '127.0.0.1', r))
  const upPort = upstream.address().port

  process.env.DEEPINFRA_PROXY_HOST = `127.0.0.1:${upPort}`
  const { mountMiddleware } = await import('../server/proxy.js')

  const proxy = http.createServer((req, res) => mountMiddleware(undefined)(req, res, () => {
    res.writeHead(404).end('not proxied')
  }))
  await new Promise((r) => proxy.listen(0, '127.0.0.1', r))
  const proxyBase = `http://127.0.0.1:${proxy.address().port}`

  await testAsync('/health answers with proxy metadata', async () => {
    const res = await fetch(`${proxyBase}/deepinfra-proxy/health`)
    const json = await res.json()
    assert.equal(json.ok, true)
    assert.equal(json.anonymousHeaderSet, 'X-Deepinfra-Source: web-embed')
  })

  await testAsync('web-embed variant reaches upstream with the right fingerprint', async () => {
    captured.length = 0
    const res = await fetch(`${proxyBase}/deepinfra-proxy/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'zai-org/GLM-5', messages: [{ role: 'user', content: 'hi' }] }),
    })
    const text = await res.text()
    assert.equal(res.status, 200)
    assert.ok(text.includes('proxied'), text)

    const hit = captured[0]
    assert.equal(hit.headers.origin, 'https://deepinfra.com')
    assert.equal(hit.headers.referer, 'https://deepinfra.com/')
    assert.equal(hit.headers['x-deepinfra-source'], 'web-embed')
    assert.equal(hit.headers.authorization, undefined, 'keyless by default')
    const sent = JSON.parse(hit.body)
    assert.equal(sent.stream, true)
    assert.deepEqual(sent.stream_options, { include_usage: true })
  })

  await testAsync('legacy variant reproduces the Python header set', async () => {
    captured.length = 0
    await fetch(`${proxyBase}/deepinfra-proxy/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-deepinfra-variant': 'legacy' },
      body: JSON.stringify({ model: 'm', messages: [] }),
    })
    const hit = captured[0]
    assert.equal(hit.headers.origin, 'https://g4f.dev')
    assert.equal(hit.headers.referer, 'https://g4f.dev')
    assert.equal(hit.headers['x-request-id'], 'Ry3LRoEwEsPHJxUrUrYpfCzm')
    assert.equal(hit.headers['x-deepinfra-source'], undefined)
  })

  await testAsync('a key from the browser becomes a Bearer header upstream', async () => {
    captured.length = 0
    await fetch(`${proxyBase}/deepinfra-proxy/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-deepinfra-key': 'di_test123' },
      body: JSON.stringify({ model: 'm', messages: [] }),
    })
    assert.equal(captured[0].headers.authorization, 'Bearer di_test123')
  })

  await testAsync('models route forwards the catalogue', async () => {
    captured.length = 0
    const res = await fetch(`${proxyBase}/deepinfra-proxy/v1/models`)
    const json = await res.json()
    assert.equal(json.data.length, 2)
    assert.equal(captured[0].path, '/v1/openai/models')
  })

  await testAsync('unknown sub-route → 404 JSON, not a crash', async () => {
    const res = await fetch(`${proxyBase}/deepinfra-proxy/nope`)
    assert.equal(res.status, 404)
  })

  await testAsync('wrong method → 405', async () => {
    const res = await fetch(`${proxyBase}/deepinfra-proxy/v1/chat/completions`)
    assert.equal(res.status, 405)
  })

  await new Promise((r) => proxy.close(r))
  await new Promise((r) => upstream.close(r))
})()

// ══════════════════════════════════════════════════════════════════
console.log(`\n${'─'.repeat(60)}`)
if (failures.length) {
  console.log(`${C.r}${C.b}${failures.length} failed${C.x} · ${passed} passed`)
  for (const f of failures) console.log(`${C.r}•${C.x} ${f.name}: ${f.err.message}`)
  process.exit(1)
}
console.log(`${C.g}${C.b}all ${passed} checks passed${C.x} — client logic + proxy verified offline`)
