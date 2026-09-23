// ══════════════════════════════════════════════════════════════
//  src/lib/headers.ts — provider headers, split by what a browser may set
//
//  Every header here is lifted verbatim from the Python providers. The Fetch
//  specification defines FORBIDDEN header names that JavaScript cannot set:
//  the browser ignores the attempt and substitutes its own value. Any name
//  starting with `Sec-` or `Proxy-` is forbidden, which covers Sec-Fetch-*
//  AND sec-ch-ua*, plus Origin, Referer, User-Agent, Cookie, Connection,
//  Accept-Encoding, Content-Length and Host.
//
//  This file does not pretend those headers can be sent. It splits them so
//  DIRECT mode sends everything settable and reports precisely which ones the
//  browser had to fill in itself — visible in the UI and in the network log.
//
//  Sources (line numbers in My PREVIOUS ENTIRE SERVER/API/providers/):
//    DeepInfra.py   _BASE_HEADERS  36-55
//    mCloudFlare.py _BASE_HEADERS  39-60
//    Dolphin.py     _BASE_HEADERS  70-85
//    LLmChat.py     _BASE_HEADERS  91-104
//    Inception.py   _hdrs()        624-643
//    Upstage (v3)   upstage_provider.py header build
// ══════════════════════════════════════════════════════════════

/** Fetch spec forbidden header names. Prefix rules handled separately. */
const FORBIDDEN_EXACT = new Set(
  [
    'Accept-Charset',
    'Accept-Encoding',
    'Access-Control-Request-Headers',
    'Access-Control-Request-Method',
    'Connection',
    'Content-Length',
    'Cookie',
    'Cookie2',
    'Date',
    'Expect',
    'Host',
    'Keep-Alive',
    'Origin',
    'Perma-Cache',
    'Pragma',
    'Referer',
    'Server',
    'Set-Cookie',
    'TE',
    'Trailer',
    'Transfer-Encoding',
    'Upgrade',
    'User-Agent',
    'Via',
  ].map((h) => h.toLowerCase()),
);

/** True when the browser will refuse to let JS set this header. */
export function isForbiddenHeader(name: string): boolean {
  const n = name.toLowerCase();
  if (FORBIDDEN_EXACT.has(n)) return true;
  // Spec: any header whose name starts with `Sec-` or `Proxy-`.
  return n.startsWith('sec-') || n.startsWith('proxy-');
}

export const UA_CHROME_145 =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/145.0.0.0 Safari/537.36';
export const UA_CHROME_146 =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/146.0.0.0 Safari/537.36';

/** Full header sets as the Python providers send them. */
export const FULL_HEADERS: Record<string, Record<string, string>> = {
  DeepInfra: {
    Accept: '*/*',
    'Accept-Encoding': 'gzip, deflate, br, zstd',
    'Accept-Language': 'en-GB,en-US;q=0.9,en;q=0.8',
    Connection: 'keep-alive',
    'Content-Type': 'application/json',
    Origin: 'https://deepinfra.com',
    Referer: 'https://deepinfra.com',
    'x-request-id': 'Ry3LRoEwEsPHJxUrUrYpfCzm',
    'sec-ch-ua': '"Not:A-Brand";v="99", "Google Chrome";v="145", "Chromium";v="145"',
    'sec-ch-ua-mobile': '?0',
    'sec-ch-ua-platform': '"Windows"',
    'User-Agent': UA_CHROME_145,
  },

  mCloudFlare: {
    Accept: 'text/event-stream',
    'Accept-Encoding': 'gzip, deflate, br',
    'Accept-Language': 'en-US,en;q=0.9',
    'Content-Type': 'application/json',
    Origin: 'https://multi-modal.ai.cloudflare.com',
    Referer: 'https://multi-modal.ai.cloudflare.com/',
    'Sec-Ch-Ua': '"Chromium";v="146","Google Chrome";v="146","Not-A.Brand";v="24"',
    'Sec-Ch-Ua-Mobile': '?0',
    'Sec-Ch-Ua-Platform': '"Windows"',
    'Sec-Fetch-Dest': 'empty',
    'Sec-Fetch-Mode': 'cors',
    'Sec-Fetch-Site': 'same-origin',
    'User-Agent': UA_CHROME_146,
  },

  Dolphin: {
    Accept: 'text/event-stream',
    'Accept-Language': 'en-US,en;q=0.9',
    'Cache-Control': 'no-cache',
    'Content-Type': 'application/json',
    Origin: 'https://chat.dphn.ai',
    Referer: 'https://chat.dphn.ai/',
    'Sec-Fetch-Dest': 'empty',
    'Sec-Fetch-Mode': 'cors',
    'Sec-Fetch-Site': 'same-origin',
    'User-Agent': UA_CHROME_145,
  },

  LLMChat: {
    'Content-Type': 'application/json',
    Accept: 'text/event-stream, */*',
    Origin: 'https://llmchat.in',
    Referer: 'https://llmchat.in/',
    'User-Agent': UA_CHROME_146,
    'sec-ch-ua': '"Chromium";v="146", "Not-A.Brand";v="24", "Google Chrome";v="146"',
    'sec-ch-ua-mobile': '?0',
    'sec-ch-ua-platform': '"Windows"',
  },

  Mercury: {
    accept: '*/*',
    'accept-language': 'en-US,en;q=0.9',
    'content-type': 'application/json',
    origin: 'https://chat.inceptionlabs.ai',
    referer: 'https://chat.inceptionlabs.ai/',
    'sec-ch-ua': '"Chromium";v="136", "Not-A.Brand";v="24", "Google Chrome";v="136"',
    'sec-ch-ua-mobile': '?0',
    'sec-ch-ua-platform': '"Windows"',
    'sec-fetch-dest': 'empty',
    'sec-fetch-mode': 'cors',
    'sec-fetch-site': 'same-origin',
  },

  Upstage: {
    Accept: 'text/event-stream',
    'Content-Type': 'application/json',
    Origin: 'https://console.upstage.ai',
    Referer: 'https://console.upstage.ai/',
    'User-Agent': UA_CHROME_146,
  },
};

/** Endpoints, lifted from the Python sources. These are the REAL provider URLs. */
export const ENDPOINTS: Record<string, string> = {
  DeepInfra: 'https://api.deepinfra.com/v1/openai/chat/completions',
  mCloudFlare: 'https://multi-modal.ai.cloudflare.com/api/inference',
  Dolphin: 'https://chat.dphn.ai/api/chat',
  LLMChat: 'https://llmchat.in/inference/stream',
  Mercury: 'https://chat.inceptionlabs.ai/api/chat',
  MercurySession: 'https://chat.inceptionlabs.ai/api/session',
  Upstage: 'https://ap-northeast-2.apistage.ai/v1/web/demo/chat/completions?include_think=true',
  UpstageConsole: 'https://console.upstage.ai',
};

/**
 * Inception.py hardcodes an upstream HTTP proxy for credential capture.
 * Flagged, not silently inherited: unknown provenance, plaintext HTTP, a
 * third-party hop that would see captured session material. Disabled by
 * default; set MERCURY_PROXY explicitly to opt in.
 */
export const MERCURY_HARDCODED_PROXY = 'http://217.217.249.160:8080';

export interface SplitHeaders {
  /** Headers JS is actually allowed to send. */
  settable: Record<string, string>;
  /** Headers the browser forbids; it will substitute its own values. */
  forbidden: Record<string, string>;
}

/** Partition a provider's header set by what the browser will honour. */
export function splitHeaders(provider: string): SplitHeaders {
  const all = FULL_HEADERS[provider] ?? {};
  const settable: Record<string, string> = {};
  const forbidden: Record<string, string> = {};
  for (const [k, v] of Object.entries(all)) {
    (isForbiddenHeader(k) ? forbidden : settable)[k] = v;
  }
  return { settable, forbidden };
}
