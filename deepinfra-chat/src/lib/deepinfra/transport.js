/**
 * ══════════════════════════════════════════════════════════════════
 *  transport.js — the request ladder that makes this actually work
 * ══════════════════════════════════════════════════════════════════
 *
 *  A browser cannot set Origin/Referer/User-Agent, so "use the URL
 *  directly" and "send the exact header set the Python file sent" cannot
 *  both be true in the same request. Rather than pretend, we try the
 *  closest thing first and degrade gracefully:
 *
 *   1  direct · web-embed marker   browser → api.deepinfra.com, real user IP,
 *                                  keyless, `X-Deepinfra-Source: web-embed`
 *   2  direct · bare               same, without the marker (fewest headers
 *                                  that can trip a preflight rejection)
 *   3  proxy  · web-embed set      local Node middleware replays it with
 *                                  Origin/Referer/UA/Sec-Fetch filled in
 *   4  proxy  · legacy set         the ORIGINAL Python header set
 *                                  (Origin https://g4f.dev + frozen x-request-id)
 *                                  — useful proof of which fingerprint is accepted
 *
 *  Retry semantics inside every rung mirror DeepInfra.py:
 *    retry codes {429,500,502,503,504,520…524} → min(2·2ⁿ + jitter, 30 s)
 *    fatal codes {400,401,403,404,405,422}      → no retry, surface at once
 */

import {
  DEEPINFRA_CHAT_ENDPOINT,
  PROXY_CHAT_ENDPOINT,
  browserHeaders,
} from './headers.js'
import { SSEParser, parseDelta, ThinkRouter, estimateTokens } from './sse.js'
import {
  RETRY_CODES,
  FATAL_CODES,
  backoffMs,
  classifyHttpError,
  classifyNetworkError,
  classifyUnexpectedPayload,
  DeepInfraError,
} from './errors.js'

export const MODES = [
  {
    id: 'auto',
    label: 'Auto',
    icon: '⚡',
    blurb: 'Try direct from your IP, fall back to the local proxy if the browser blocks it.',
  },
  {
    id: 'direct',
    label: 'Direct',
    icon: '🌐',
    blurb: 'Always browser → api.deepinfra.com (real user IP, no proxy).',
  },
  {
    id: 'proxy',
    label: 'Proxy',
    icon: '🛡️',
    blurb: 'Always through the local Node middleware — full header spoof, Docker-proof.',
  },
  {
    id: 'demo',
    label: 'Demo',
    icon: '🧪',
    blurb: 'Offline canned stream — proves the UI works with zero network.',
  },
]

/** Build the ordered list of attempts for a mode. */
export function planLadder({ mode = 'auto', apiKey = '' } = {}) {
  const keyed = Boolean(apiKey)
  const keyNote = keyed ? ' + key' : ' · keyless'

  const direct = (webEmbed) => ({
    id: webEmbed ? 'direct-webembed' : 'direct-minimal',
    kind: 'direct',
    webEmbed,
    label: webEmbed
      ? `Direct · browser → api.deepinfra.com (web-embed${keyNote})`
      : `Direct · browser → api.deepinfra.com (bare${keyNote})`,
    blurb: webEmbed
      ? 'Your IP, your browser; the anonymous web-embed marker in a header only JS can add.'
      : 'Your IP, your browser, only CORS-safelisted-ish headers — no custom marker.',
    endpoint: DEEPINFRA_CHAT_ENDPOINT,
  })

  const proxy = (variant) => ({
    id: `proxy-${variant}`,
    kind: 'proxy',
    variant,
    webEmbed: variant === 'web-embed',
    label:
      variant === 'legacy'
        ? `Proxy · legacy Python header set${keyNote}`
        : `Proxy · web-embed header set${keyNote}`,
    blurb:
      variant === 'legacy'
        ? 'Origin https://g4f.dev + frozen x-request-id — exactly what DeepInfra.py sent.'
        : 'Origin https://deepinfra.com + X-Deepinfra-Source: web-embed — what g4f really uses.',
    endpoint: PROXY_CHAT_ENDPOINT,
  })

  const demo = {
    id: 'demo',
    kind: 'demo',
    label: 'Demo · offline canned stream',
    blurb: 'No network at all.',
    endpoint: 'about:blank',
  }

  switch (mode) {
    case 'demo':
      return [demo]
    case 'direct':
      return [direct(true), direct(false)]
    case 'proxy':
      return [proxy('web-embed'), proxy('legacy')]
    default:
      return [direct(true), direct(false), proxy('web-embed'), proxy('legacy')]
  }
}

function makeSignal(parent) {
  const ctrl = new AbortController()
  if (parent) {
    if (parent.aborted) ctrl.abort(parent.reason)
    else parent.addEventListener('abort', () => ctrl.abort(parent.reason), { once: true })
  }
  return ctrl
}

const sleep = (ms, signal) =>
  new Promise((resolve, reject) => {
    const t = setTimeout(resolve, ms)
    signal?.addEventListener(
      'abort',
      () => {
        clearTimeout(t)
        reject(Object.assign(new Error('aborted'), { name: 'AbortError' }))
      },
      { once: true },
    )
  })

/**
 * Stream one chat completion.
 *
 * @param {object} o
 * @param {Array<{role:string,content:string}>} o.messages
 * @param {string} o.model                 full org/model id
 * @param {string} [o.mode]                auto | direct | proxy | demo
 * @param {string} [o.apiKey]
 * @param {number} [o.temperature]
 * @param {number} [o.maxTokens]
 * @param {number} [o.topP]
 * @param {number} [o.retries]             extra attempts per rung (DeepInfra.py default: 3)
 * @param {AbortSignal} [o.signal]
 * @param {(chunk:string)=>void} o.onDelta
 * @param {(chunk:string)=>void} o.onReasoning
 * @param {(e:{level:string,text:string})=>void} [o.onLog]
 * @param {(s:{rung:string,label:string,index:number,total:number})=>void} [o.onRung]
 * @returns {Promise<{content:string,reasoning:string,usage:object|null,rung:object,ttfbMs:number,totalMs:number,attempts:Array}>}
 */
export async function streamChat(o) {
  const {
    messages,
    model,
    mode = 'auto',
    apiKey = '',
    temperature = 0.7,
    maxTokens = 2048,
    topP = 1,
    retries = 3,
    signal,
    onDelta,
    onReasoning,
    onLog = () => {},
    onRung = () => {},
  } = o

  const ladder = planLadder({ mode, apiKey })
  const attempts = []
  let lastError = null

  for (let i = 0; i < ladder.length; i += 1) {
    const rung = ladder[i]
    if (signal?.aborted) throw classifyNetworkError({ name: 'AbortError' }, { rungLabel: rung.label })

    onRung({ rung: rung.id, label: rung.label, index: i + 1, total: ladder.length })
    onLog({ level: 'info', text: `▸ rung ${i + 1}/${ladder.length}: ${rung.label}` })

    try {
      const result =
        rung.kind === 'demo'
          ? await runDemoRung({ ...o, rung })
          : await runHttpRung({ ...o, rung, retries, onLog, signal })

      onLog({ level: 'ok', text: `✔ ${rung.id} succeeded — ttfb ${result.ttfbMs} ms` })
      return { ...result, rung, attempts: [...attempts, { rung: rung.id, ok: true }] }
    } catch (err) {
      const classified =
        err instanceof DeepInfraError
          ? err
          : classifyNetworkError(err, { rungLabel: rung.label, endpoint: rung.endpoint })

      attempts.push({ rung: rung.id, ok: false, error: classified.toJSON() })
      onLog({ level: 'warn', text: `✘ ${rung.id}: ${classified.title}` })

      if (classified.kind === 'abort') throw classified
      lastError = classified

      // A 400/422 is our own payload bug — no point replaying it elsewhere.
      if (classified.status === 400 || classified.status === 422) throw classified
    }
  }

  // Prefer the last *authoritative* answer (a real HTTP status from the
  // upstream) over a generic "all routes failed" wrapper — that is the
  // information the user actually needs. Pure transport/CORS failures get
  // the wrapper, because none of the rungs produced an answer at all.
  if (lastError && lastError.status) {
    lastError.attempts = attempts
    lastError.hint =
      `${lastError.hint} (every route was tried: ${attempts.map((a) => a.rung).join(' → ')})`
    throw lastError
  }

  const summary = new DeepInfraError({
    kind: 'exhausted',
    title: 'Every route failed',
    message: lastError ? lastError.message : 'No route could stream a response.',
    hint: 'Open the diagnostics drawer (⌘/Ctrl-K → diagnostics) to see each rung, then run `npm run doctor` in a terminal for the definitive answer.',
    status: 0,
    retryable: true,
  })
  summary.cause = lastError
  summary.attempts = attempts
  throw summary
}

// ══════════════════════════════════════════════════════════════════
//  One HTTP rung
// ══════════════════════════════════════════════════════════════════
async function runHttpRung({
  rung,
  messages,
  model,
  apiKey,
  temperature,
  maxTokens,
  topP,
  retries,
  signal,
  onDelta,
  onReasoning,
  onLog,
}) {
  const started = performance.now()
  let attempt = 0
  let lastErr = null

  while (attempt <= retries) {
    if (attempt > 0) {
      const wait = backoffMs(attempt - 1)
      onLog({ level: 'warn', text: `↻ retry ${attempt}/${retries} in ${(wait / 1000).toFixed(2)} s` })
      await sleep(wait, signal)
    }
    attempt += 1

    const ctrl = makeSignal(signal)
    const headers = buildHeaders(rung, apiKey)
    const body = JSON.stringify({
      model,
      messages,
      temperature,
      max_tokens: maxTokens,
      top_p: topP,
      stream: true,
      stream_options: { include_usage: true },
    })

    try {
      const res = await fetch(rung.endpoint, { method: 'POST', headers, body, signal: ctrl.signal })

      if (!res.ok) {
        const text = await safeText(res)
        const err = classifyHttpError(res.status, text, rung.label)

        if (RETRY_CODES.has(res.status) && attempt <= retries) {
          lastErr = err
          onLog({ level: 'warn', text: `${rung.id}: HTTP ${res.status} — will retry` })
          continue
        }
        if (FATAL_CODES.has(res.status)) throw err
        throw err
      }

      return await consumeStream({ res, rung, started, attempt, onDelta, onReasoning, onLog, signal })
    } catch (err) {
      if (err instanceof DeepInfraError) {
        if (err.status && RETRY_CODES.has(err.status) && attempt <= retries) {
          lastErr = err
          continue
        }
        throw err
      }
      const classified = classifyNetworkError(err, { rungLabel: rung.label, endpoint: rung.endpoint })
      // transport hiccups are retryable inside the rung too (Python reset+retried here)
      if (classified.retryable && attempt <= retries && classified.kind !== 'cors') {
        lastErr = classified
        onLog({ level: 'warn', text: `${rung.id}: ${classified.title} — transport retry` })
        continue
      }
      throw classified
    }
  }

  throw lastErr ?? new DeepInfraError({ kind: 'unknown', title: 'Unknown failure', message: 'no attempt succeeded' })
}

function buildHeaders(rung, apiKey) {
  if (rung.kind === 'proxy') {
    const h = { 'Content-Type': 'application/json', Accept: 'text/event-stream' }
    if (apiKey) h['x-deepinfra-key'] = apiKey
    h['x-deepinfra-variant'] = rung.variant ?? 'web-embed'
    return h
  }
  return browserHeaders({ apiKey: apiKey || undefined, webEmbed: Boolean(rung.webEmbed) })
}

async function safeText(res) {
  try {
    return (await res.text()).slice(0, 1000)
  } catch {
    return ''
  }
}

// ══════════════════════════════════════════════════════════════════
//  Stream consumption
// ══════════════════════════════════════════════════════════════════
async function consumeStream({ res, rung, started, attempt, onDelta, onReasoning, onLog, signal }) {
  const contentType = res.headers.get('content-type') || ''
  const parser = new SSEParser()
  const think = new ThinkRouter()
  const decoder = new TextDecoder('utf-8') // explicit UTF-8 — the Python file's charset trap, avoided

  let content = ''
  let reasoning = ''
  let usage = null
  let ttfbMs = 0
  let sawFrame = false
  let firstBody = ''

  const reader = res.body.getReader()
  try {
    for (;;) {
      if (signal?.aborted) throw Object.assign(new Error('aborted'), { name: 'AbortError' })
      const { value, done } = await reader.read()
      if (done) break
      const text = decoder.decode(value, { stream: true })

      if (!sawFrame && !firstBody) firstBody = text.slice(0, 400)

      for (const evt of parser.push(text)) {
        if (!sawFrame) {
          sawFrame = true
          ttfbMs = Math.round(performance.now() - started)
        }
        let d
        try {
          d = parseDelta(evt.data)
        } catch (err) {
          throw new DeepInfraError({
            kind: 'upstream',
            title: 'Upstream error frame',
            message: err.message,
            hint: 'The model or account rejected the request mid-stream.',
            rung: rung.label,
          })
        }
        if (d.usage) usage = d.usage
        if (d.done) {
          onLog({ level: 'ok', text: '← [DONE]' })
          reader.cancel().catch(() => {})
          break
        }

        if (d.reasoning) {
          reasoning += d.reasoning
          onReasoning(d.reasoning)
        }
        if (d.content) {
          const routed = think.push(d.content)
          if (routed.reasoning) {
            reasoning += routed.reasoning
            onReasoning(routed.reasoning)
          }
          if (routed.content) {
            content += routed.content
            onDelta(routed.content)
          }
        }
      }
    }
    const tail = think.flush()
    if (tail.content) {
      content += tail.content
      onDelta(tail.content)
    }
    if (tail.reasoning) {
      reasoning += tail.reasoning
      onReasoning(tail.reasoning)
    }
  } finally {
    try {
      await reader.cancel()
    } catch {
      /* already closed */
    }
  }

  if (!sawFrame) {
    throw classifyUnexpectedPayload(contentType, firstBody, rung.label)
  }

  return {
    content,
    reasoning,
    usage: usage ?? {
      prompt_tokens: estimateTokens(JSON.stringify([])), // replaced by caller if known
      completion_tokens: estimateTokens(content),
    },
    ttfbMs,
    totalMs: Math.round(performance.now() - started),
    attempts: [{ attempt, status: res.status, contentType }],
  }
}

// ══════════════════════════════════════════════════════════════════
//  Demo rung (offline)
// ══════════════════════════════════════════════════════════════════
const DEMO_REASONING =
  'No network needed for this one. I am streaming a canned answer so you can watch ' +
  'the UI: token-by-token markdown, the thinking panel, usage accounting and the ' +
  'copy button on code blocks.'

const DEMO_ANSWER = `### Demo stream ✔

The real request this app sends (identical body to the Python provider, minus the
header lies a browser cannot tell):

\`\`\`js
POST https://api.deepinfra.com/v1/openai/chat/completions
X-Deepinfra-Source: web-embed      // the whole anonymous-access trick
{
  model: "zai-org/GLM-5",
  messages: [...],
  stream: true
}
\`\`\`

**Why the fallback ladder exists**

| rung | who sends it | Origin the server sees |
| --- | --- | --- |
| direct | your browser | your own origin — cannot be faked |
| proxy | local Node | \`https://deepinfra.com\` + web-embed marker |

- [x] markdown, tables, task lists
- [x] streaming cursor + thinking panel
- [ ] you trying it with a live model 😄

> Flip to **Auto** mode and send a real message when you are ready.`

async function runDemoRung({ rung, signal, onDelta, onReasoning, onLog }) {
  const started = performance.now()
  onLog({ level: 'info', text: 'demo: streaming canned answer (no network)' })

  const emit = async (text, sink, minMs = 14, maxMs = 42) => {
    const parts = text.match(/\S+\s*|\s+/g) ?? [text]
    for (const part of parts) {
      if (signal?.aborted) throw Object.assign(new Error('aborted'), { name: 'AbortError' })
      sink(part)
      await sleep(minMs + Math.random() * (maxMs - minMs), signal)
    }
  }

  await sleep(220, signal)
  await emit(DEMO_REASONING, onReasoning, 10, 26)
  await sleep(160, signal)
  await emit(DEMO_ANSWER, onDelta, 12, 38)
  await sleep(80, signal)

  const content = DEMO_ANSWER
  const reasoning = DEMO_REASONING
  return {
    content,
    reasoning,
    usage: {
      prompt_tokens: estimateTokens('demo'),
      completion_tokens: estimateTokens(content),
    },
    ttfbMs: 220,
    totalMs: Math.round(performance.now() - started),
    attempts: [{ attempt: 1, status: 'demo' }],
    rung,
  }
}
