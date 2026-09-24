/**
 * config.js — endpoints, model registry, constants.
 *
 * Defaults point at the REAL Upstage console + demo completions API.
 * Every URL is resolved at call time so env overrides work post-import.
 *
 *   UPSTAGE_CONSOLE_URL   default https://console.upstage.ai
 *   UPSTAGE_API_BASE      default https://ap-northeast-2.apistage.ai
 *   UPSTAGE_CACHE_DIR     default <os.tmpdir>/.cache/upstage
 */
import os from 'node:os';
import path from 'node:path';

// ── hard guarantee: never route Upstage traffic through any proxy ──
// (user IP only — clear standard proxy env vars that undici/got honor)
for (const k of [
  'HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'http_proxy', 'https_proxy', 'all_proxy',
]) {
  delete process.env[k];
}
process.env.NO_PROXY = '*';
process.env.no_proxy = '*';


export const consoleUrl = () =>
  (process.env.UPSTAGE_CONSOLE_URL || 'https://console.upstage.ai').replace(/\/+$/, '');

export const apiBase = () =>
  (process.env.UPSTAGE_API_BASE || 'https://ap-northeast-2.apistage.ai').replace(/\/+$/, '');

export const chatPath = () => '/playground/chat';

export const completionsUrl = () =>
  `${apiBase()}/v1/web/demo/chat/completions?include_think=true`;

export const credFile = () =>
  path.join(
    process.env.UPSTAGE_CACHE_DIR || path.join(os.tmpdir(), '.cache', 'upstage'),
    'upstage_creds.json',
  );

export const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/146.0.0.0 Safari/537.36';

export const UA_HEADERS = { 'user-agent': UA };

/** Server-action names embedded in console client JS bundles. */
export const ACTION_TOKEN = 'getConsoleCsrfToken';
export const ACTION_INIT = 'authAction';

/** Cap on JS chunks scanned during credential capture. */
export const MAX_CHUNK_SCAN = 80;

/** Timeouts (ms): page/actions vs long generations. */
export const CONNECT_TIMEOUT = 20_000;
export const STREAM_TIMEOUT = 300_000;

/**
 * Model registry — mirrors New Upstage Change Logs v3, plus the two
 * models the live console now advertises (solar-pro4 / solar-mini-4)
 * which share the same playground completions contract.
 */
export const MODELS = {
  'solar-pro3': {
    reasoning: ['low', 'medium', 'high'],
    search: true,
    system: '',
    temperature: 0.8,
    max_tokens: 65536,
    metadata: null,
    label: 'Solar Pro 3 — 102B MoE reasoning',
  },
  'solar-pro2': {
    reasoning: ['low', 'high'],
    search: true,
    system: '',
    temperature: 0.8,
    max_tokens: 16383,
    metadata: null,
    label: 'Solar Pro 2 — reasoning + tool use',
  },
  'solar-pro4': {
    reasoning: ['low', 'medium', 'high'],
    search: true,
    system: '',
    temperature: 0.8,
    max_tokens: 65536,
    metadata: null,
    label: 'Solar Pro 4 — flagship agentic',
  },
  'syn-pro': {
    reasoning: ['low', 'high'],
    search: true,
    system: '',
    temperature: 0.7,
    max_tokens: 16384,
    metadata: {
      helpfulness: 4, correctness: 4, coherence: 4,
      complexity: 4, verbosity: 4, quality: 4,
      toxicity: 0, humor: 0, creativity: 0,
    },
    label: 'Syn Pro — Japanese enterprise 30B',
  },
  'solar-mini-4': {
    reasoning: ['low', 'medium', 'high'],
    search: true,
    system: '',
    temperature: 0.8,
    max_tokens: 32768,
    metadata: null,
    label: 'Solar Mini 4 — compact agentic',
  },
  'upstage/solar-1-mini-chat': {
    reasoning: null,
    search: true,
    system: '',
    temperature: 0.8,
    max_tokens: 16383,
    metadata: null,
    label: 'Solar Mini — lightweight chat',
  },
};

export const MODEL_ALIASES = {
  'solar-pro3': 'solar-pro3',
  'solar-pro2': 'solar-pro2',
  'solar-pro4': 'solar-pro4',
  'solar-pro-4': 'solar-pro4',
  'pro4': 'solar-pro4',
  'solar-pro-3': 'solar-pro3',
  'solar-pro-2': 'solar-pro2',
  'syn-pro': 'syn-pro',
  'solar-mini-4': 'solar-mini-4',
  'solar-mini4': 'solar-mini-4',
  'mini4': 'solar-mini-4',
  'solar-1-mini-chat': 'upstage/solar-1-mini-chat',
  'upstage/solar-1-mini-chat': 'upstage/solar-1-mini-chat',
  'solar3': 'solar-pro3',
  'solar2': 'solar-pro2',
  'pro3': 'solar-pro3',
  'pro2': 'solar-pro2',
  'syn': 'syn-pro',
  'mini': 'upstage/solar-1-mini-chat',
};

export function resolveModel(val) {
  if (!val) return 'solar-pro3';
  const v = String(val).toLowerCase().trim();
  if (MODEL_ALIASES[v]) return MODEL_ALIASES[v];
  if (MODELS[v]) return v;
  for (const name of Object.keys(MODELS)) {
    if (v.includes(name.toLowerCase())) return name;
  }
  return val;
}
