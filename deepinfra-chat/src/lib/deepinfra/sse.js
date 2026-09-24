/**
 * ══════════════════════════════════════════════════════════════════
 *  SSE + delta parsing
 * ══════════════════════════════════════════════════════════════════
 *
 *  DeepInfra speaks the OpenAI SSE dialect:
 *
 *      data: {"choices":[{"delta":{"role":"assistant"},"index":0}]}
 *      data: {"choices":[{"delta":{"content":"Hel"},"index":0}]}
 *      data: {"choices":[{"delta":{"reasoning_content":"…"},"index":0}]}
 *      data: {"choices":[],"usage":{"prompt_tokens":9,"completion_tokens":3}}
 *      data: [DONE]
 *
 *  The Python provider only ever read `choices[0].delta.content`. Here we
 *  keep everything: content, reasoning_content and usage.
 */

/**
 * Incremental SSE parser. Feed it decoded text in arbitrary chunks;
 * it yields complete events (which may arrive split across chunks).
 */
export class SSEParser {
  constructor() {
    this.buffer = ''
  }

  /**
   * @param {string} text
   * @returns {{data: string}[]} complete `data:` payloads found so far
   */
  push(text) {
    this.buffer += text
    const out = []

    // Normalise CRLF, then walk complete lines.
    let idx
    while ((idx = this.buffer.indexOf('\n')) !== -1) {
      let line = this.buffer.slice(0, idx)
      this.buffer = this.buffer.slice(idx + 1)
      if (line.endsWith('\r')) line = line.slice(0, -1)

      if (line === '' || line.startsWith(':')) continue // keep-alive / comment
      if (!line.startsWith('data:')) continue // event:, id:, retry:

      const payload = line.slice(5).trimStart()
      out.push({ data: payload })
    }
    return out
  }
}

/**
 * Pull the interesting bits out of one SSE json payload.
 * @returns {{done:boolean, content:string, reasoning:string, usage:object|null, finishReason:string|null}}
 */
export function parseDelta(payload) {
  const empty = { done: false, content: '', reasoning: '', usage: null, finishReason: null }
  if (payload === '[DONE]') return { ...empty, done: true }

  let json
  try {
    json = JSON.parse(payload)
  } catch {
    return empty // partial/garbled frame — ignored, exactly like Python does
  }

  if (json?.error) {
    const message = typeof json.error === 'string' ? json.error : json.error?.message
    throw new Error(message || 'upstream reported an error')
  }

  const usage = json?.usage ?? null
  const choice = json?.choices?.[0]
  if (!choice) return { ...empty, usage }

  const delta = choice.delta ?? {}
  return {
    done: false,
    content: typeof delta.content === 'string' ? delta.content : '',
    reasoning:
      (typeof delta.reasoning_content === 'string' && delta.reasoning_content) ||
      (typeof delta.reasoning === 'string' && delta.reasoning) ||
      '',
    usage,
    finishReason: choice.finish_reason ?? null,
  }
}

/**
 * Some endpoints (and every Ollama-style proxy) inline the chain of thought
 * as `…<think>reasoning</think>answer`. The Python server used to reassemble
 * those tags; we do the same here, but on the client, so a model that
 * streams reasoning either way still lights up the “thinking” panel.
 */
const OPEN_TAG = '<think>'
const CLOSE_TAG = '</think>'

/**
 * Longest suffix of `text` that is a *prefix* of `tag` (e.g. "<thi" for
 * "<think>"). That suffix is held back so a tag split across two chunks is
 * never emitted as text.
 */
function holdBack(text, tag) {
  const max = Math.min(text.length, tag.length - 1)
  for (let len = max; len > 0; len -= 1) {
    if (text.endsWith(tag.slice(0, len))) return text.slice(-len)
  }
  return ''
}

export class ThinkRouter {
  constructor() {
    this.inThink = false
    this.pending = ''
    this.sawTags = false
  }

  /** @returns {{content:string, reasoning:string}} */
  push(content) {
    if (!content) return { content: '', reasoning: '' }

    let rest = this.pending + content
    this.pending = ''
    let contentOut = ''
    let reasoningOut = ''

    for (;;) {
      if (!this.inThink) {
        const open = rest.indexOf(OPEN_TAG)
        if (open === -1) {
          const keep = holdBack(rest, OPEN_TAG)
          contentOut += keep ? rest.slice(0, rest.length - keep.length) : rest
          this.pending = keep
          break
        }
        this.sawTags = true
        contentOut += rest.slice(0, open)
        rest = rest.slice(open + OPEN_TAG.length)
        this.inThink = true
      } else {
        const close = rest.indexOf(CLOSE_TAG)
        if (close === -1) {
          const keep = holdBack(rest, CLOSE_TAG)
          reasoningOut += keep ? rest.slice(0, rest.length - keep.length) : rest
          this.pending = keep
          break
        }
        reasoningOut += rest.slice(0, close)
        rest = rest.slice(close + CLOSE_TAG.length)
        this.inThink = false
      }
    }

    return { content: contentOut, reasoning: reasoningOut }
  }

  flush() {
    const pending = this.pending
    this.pending = ''
    if (!pending) return { content: '', reasoning: '' }
    return this.inThink ? { content: '', reasoning: pending } : { content: pending, reasoning: '' }
  }
}

/** Rough token estimate — DeepInfra's usage frame is authoritative when present. */
export function estimateTokens(text) {
  if (!text) return 0
  return Math.max(1, Math.round(text.length / 4))
}
