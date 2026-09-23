// ══════════════════════════════════════════════════════════════
//  bridge/headers.mjs — the reason the bridge exists
//
//  Every header set below is lifted verbatim from the Python providers. They
//  include ORIGIN, REFERER and SEC-FETCH-*, which the Fetch specification makes
//  FORBIDDEN request headers: a browser silently ignores any attempt by
//  JavaScript to set them. Node has no such restriction.
//
//  Sources (line numbers in My PREVIOUS ENTIRE SERVER/API/providers/):
//    DeepInfra.py   _BASE_HEADERS  36-55
//    mCloudFlare.py _BASE_HEADERS  39-60
//    Dolphin.py     _BASE_HEADERS  70-85
//    LLmChat.py     _BASE_HEADERS  91-104
//    Inception.py   _hdrs()        624-643
//    Upstage (v3)   upstage_provider.py header build
//
//  See ARCHITECTURE.md §2 for why this cannot be done in the browser.
// ══════════════════════════════════════════════════════════════

const UA_CHROME_145 =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/145.0.0.0 Safari/537.36';
const UA_CHROME_146 =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/146.0.0.0 Safari/537.36';

export const HEADERS = {
  DeepInfra: {
    Accept: '*/*',
    'Accept-Encoding': 'gzip, deflate, br, zstd',
    'Accept-Language': 'en-GB,en-US;q=0.9,en;q=0.8',
    Connection: 'keep-alive',
    'Content-Type': 'application/json',
    // DeepInfra.py:34  _ORIGIN = "https://g4f.dev"  — NOT deepinfra.com.
    Origin: 'https://g4f.dev',
    Referer: 'https://g4f.dev',
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
    // FORBIDDEN in browsers — the whole point of this file.
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

  // Mercury additionally requires a captured session token + cookies.
  // Inception.py _hdrs() injects x-session-token and the stored UA at runtime.
  Mercury: {
    accept: '*/*',
    'accept-language': 'en-US,en;q=0.9',
    'content-type': 'application/json',
    origin: 'https://chat.inceptionlabs.ai',
    referer: 'https://chat.inceptionlabs.ai/',
    'sec-ch-ua': '"Chromium";v="136","Not-A.Brand";v="24", "Google Chrome";v="136"',
    'sec-ch-ua-mobile': '?0',
    'sec-ch-ua-platform': '"Windows"',
    'sec-fetch-dest': 'empty',
    'sec-fetch-mode': 'cors',
    'sec-fetch-site': 'same-origin',
  },

  // upstage_provider.py _stream_events() — the ACTUAL request headers.
  // accept is */* (not text/event-stream) and three x- headers are
  // load-bearing: x-csrf-token and x-session-id are attached at runtime from
  // the captured session. An earlier revision invented this set and omitted
  // all three, so Upstage could never authenticate.
  Upstage: {
    accept: '*/*',
    'content-type': 'application/json',
    origin: 'https://console.upstage.ai',
    referer: 'https://console.upstage.ai/',
    'x-upstage-logging-enabled': 'true',
    'User-Agent': UA_CHROME_146,
  },
};

/** Endpoints, lifted from the Python sources. */
export const ENDPOINTS = {
  DeepInfra: 'https://api.deepinfra.com/v1/openai/chat/completions',
  mCloudFlare: 'https://multi-modal.ai.cloudflare.com/api/inference',
  Dolphin: 'https://chat.dphn.ai/api/chat',
  LLMChat: 'https://llmchat.in/inference/stream',
  Mercury: 'https://chat.inceptionlabs.ai/api/chat',
  MercurySession: 'https://chat.inceptionlabs.ai/api/session',
  Upstage: 'https://ap-northeast-2.apistage.ai/v1/web/demo/chat/completions?include_think=true',
  UpstageConsole: 'https://console.upstage.ai',
  // upstage_provider.py:99 _CHAT_EP — the Next.js page whose client bundles
  // embed the server-action id, and the endpoint the RSC POST goes to.
  UpstageChatEp: 'https://console.upstage.ai/playground/chat',
};

/**
 * Upstage's API host is a DIFFERENT registrable domain from the console
 * (apistage.ai vs upstage.ai), so the Python client attaches the console's
 * cookies to the API request MANUALLY. A browser cannot read another site's
 * cookies and cannot forward them cross-site, which is why Upstage is the one
 * provider a pure browser SPA provably cannot authenticate against. Node can,
 * because it holds its own cookie jar.
 */
export const UPSTAGE_NEEDS_COOKIE_JAR = true;

/**
 * Inception.py hardcodes an upstream HTTP proxy for credential capture.
 * Flagged, not silently inherited: its provenance is unknown and it is a
 * plaintext-HTTP third-party hop that would see captured session material.
 * Disabled by default here; set MERCURY_PROXY explicitly to opt in.
 */
export const MERCURY_HARDCODED_PROXY = 'http://217.217.249.160:8080';
export const mercuryProxy = () => process.env.MERCURY_PROXY || null;

/** System-prompt prefixes differ per provider and are load-bearing. */
export const SYS_PREFIX = {
  Upstage: '[SYSTEM INSTRUCTION]',
  Mercury: '[SYSTEM INSTRUCTION]',
  Dolphin: '[SYSTEM] YOU HAVE TO ACT AS :',
};
