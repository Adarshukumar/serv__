/**
 * ══════════════════════════════════════════════════════════════════
 *  The reverse-engineering notes, as code
 * ══════════════════════════════════════════════════════════════════
 *
 *  The DeepInfra endpoint is OpenAI-compatible:
 *      POST https://api.deepinfra.com/v1/openai/chat/completions
 *
 *  Officially it wants `Authorization: Bearer <key>`.
 *  The reverse-engineered trick is that the *web-embed* flavour of the
 *  deepinfra.com playground is allowed to call it from a browser with
 *  no key, and it identifies itself with the header
 *
 *      X-Deepinfra-Source: web-embed
 *
 *  with a plain deepinfra.com origin.
 *
 *  ┌──────────────────────────┬────────────────────────────┬───────────────┐
 *  │ header                   │ Python DeepInfra.py        │ g4f real one  │
 *  ├──────────────────────────┼────────────────────────────┼───────────────┤
 *  │ Origin                   │ https://g4f.dev            │ deepinfra.com │
 *  │ Referer                  │ https://g4f.dev            │ deepinfra.com/│
 *  │ X-Deepinfra-Source       │ ❌ missing                 │ web-embed     │
 *  │ x-request-id             │ frozen constant            │ (per request) │
 *  │ Authorization            │ ❌ never sent              │ ❌ keyless    │
 *  └──────────────────────────┴────────────────────────────┴───────────────┘
 *
 *  …and here is the part that decides this project's architecture:
 *
 *  ⚠️  A BROWSER IS NOT ALLOWED TO SET:  Origin · Referer · User-Agent ·
 *      Sec-Fetch-* · Cookie · Host.  They are forbidden request headers and
 *      are either stripped or cause the fetch to be rejected outright.
 *
 *  So "using the URL directly from the browser" works for the *endpoint*
 *  and the *body*, but the browser always stamps its OWN origin
 *  (http://localhost:5173, https://<sandbox>.e2b.app, …). We cannot choose it.
 *
 *  Consequences, and how this app handles them:
 *    • request now runs on YOUR real IP, from YOUR browser  ✅ (that was the goal)
 *    • the server sees a foreign Origin + no web-embed marker → it may
 *      refuse (403) or, more likely, the response lacks CORS headers so
 *      the browser hides it from JS (net::ERR_FAILED / "Failed to fetch")
 *    • therefore we run a fallback LADDER: try direct, and if the browser
 *      blocks it, replay the identical request through the local Node
 *      proxy (server/proxy.js) which CAN set every header.
 */

export const DEEPINFRA_BASE = 'https://api.deepinfra.com'
export const DEEPINFRA_CHAT_ENDPOINT = `${DEEPINFRA_BASE}/v1/openai/chat/completions`
export const DEEPINFRA_MODELS_ENDPOINT = `${DEEPINFRA_BASE}/v1/openai/models`

/** Same-origin path, proxied by Vite (server/proxy.js). Never a hard-coded host. */
export const PROXY_BASE = '/deepinfra-proxy'
export const PROXY_CHAT_ENDPOINT = `${PROXY_BASE}/v1/chat/completions`
export const PROXY_MODELS_ENDPOINT = `${PROXY_BASE}/v1/models`

/** Request headers a browser IS allowed to attach. */
export function browserHeaders({ apiKey, webEmbed = false } = {}) {
  const h = {
    'Content-Type': 'application/json',
    Accept: 'text/event-stream',
  }
  if (webEmbed) h['X-Deepinfra-Source'] = 'web-embed'
  if (apiKey) h['Authorization'] = `Bearer ${apiKey}`
  return h
}

/** Headers the local Node proxy injects (it is not a browser, so it may). */
export const SERVER_SPOOF_HEADERS = {
  Origin: 'https://deepinfra.com',
  Referer: 'https://deepinfra.com/',
  'X-Deepinfra-Source': 'web-embed',
  'Sec-Fetch-Dest': 'empty',
  'Sec-Fetch-Mode': 'cors',
  'Sec-Fetch-Site': 'same-site',
  'User-Agent':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
    '(KHTML, like Gecko) Chrome/145.0.0.0 Safari/537.36',
}

/** Kept for the honesty of the table above / documentation views. */
export const FORBIDDEN_IN_BROWSER = [
  'Origin', 'Referer', 'User-Agent', 'Host', 'Cookie', 'Connection',
  'Content-Length', 'Sec-Fetch-Dest', 'Sec-Fetch-Mode', 'Sec-Fetch-Site', 'sec-ch-ua',
]
