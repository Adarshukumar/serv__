/**
 * ══════════════════════════════════════════════════════════════════
 *  Model catalogue — ported 1:1 from the Python provider, then widened
 * ══════════════════════════════════════════════════════════════════
 *
 *  `verified: 'provider'`  → the alias exists verbatim in
 *                            API/providers/DeepInfra.py (MODELS dict)
 *  `verified: 'docs'`      → model id documented by DeepInfra / used by
 *                            g4f's DeepInfraChat provider
 *
 *  The app never trusts either list blindly: Settings → “Sync models”
 *  asks the live catalogue and marks anything that no longer exists.
 */

export const ALIASES = {
  'step-3.5-flash': 'stepfun-ai/Step-3.5-Flash',

  'qwen-3.5-397b-a17b': 'Qwen/Qwen3.5-397B-A17B',
  'qwen-3.5-122b-a10b': 'Qwen/Qwen3.5-122B-A10B',
  'qwen-3.5-35b-a3b': 'Qwen/Qwen3.5-35B-A3B',
  'qwen-3.5-27b': 'Qwen/Qwen3.5-27B',
  'qwen-3.5-9b': 'Qwen/Qwen3.5-9B',
  'qwen-3.5-4b': 'Qwen/Qwen3.5-4B',
  'qwen-3.5-2b': 'Qwen/Qwen3.5-2B',
  'qwen-3.5-0.8b': 'Qwen/Qwen3.5-0.8B',

  'nvidia-nemotron-3-super-120b-a12b': 'nvidia/NVIDIA-Nemotron-3-Super-120B-A12B',
  'nemotron-3-nano-30b-a3b': 'nvidia/Nemotron-3-Nano-30B-A3B',

  'glm-5': 'zai-org/GLM-5',
  'glm-4.7-flash': 'zai-org/GLM-4.7-Flash',

  'minimax-m2.5': 'MiniMaxAI/MiniMax-M2.5',

  'qwen-3-max': 'Qwen/Qwen3-Max',
  'qwen-3-max-thinking': 'Qwen/Qwen3-Max-Thinking',

  'kimi-k2.5': 'moonshotai/Kimi-K2.5',

  'deepseek-v3.2': 'deepseek-ai/DeepSeek-V3.2',
}

export const DEFAULT_ALIAS = 'nemotron-3-nano-30b-a3b'

/**
 * Mirror of `_resolve()` in DeepInfra.py — including its quirk:
 * a name containing "/" (or an unknown alias) is passed through untouched,
 * so typos become upstream 404s instead of local errors. We keep the same
 * rule but surface a UI warning when the id is not in the catalogue.
 */
export function resolveModel(input) {
  if (!input) return ALIASES[DEFAULT_ALIAS]
  const key = String(input).trim()
  if (key.includes('/')) return key
  return ALIASES[key.toLowerCase()] ?? key
}

export const CATALOG = [
  // ── reasoning / flagship ────────────────────────────────────────────
  { id: 'Qwen/Qwen3-Max-Thinking', alias: 'qwen-3-max-thinking', label: 'Qwen3 Max Thinking', family: 'Qwen', ctx: 262000, reasoning: true, verified: 'provider', note: 'native reasoning_content stream' },
  { id: 'Qwen/Qwen3-Max', alias: 'qwen-3-max', label: 'Qwen3 Max', family: 'Qwen', ctx: 262000, verified: 'provider' },
  { id: 'deepseek-ai/DeepSeek-V3.2', alias: 'deepseek-v3.2', label: 'DeepSeek V3.2', family: 'DeepSeek', ctx: 163000, reasoning: true, verified: 'provider' },
  { id: 'moonshotai/Kimi-K2.5', alias: 'kimi-k2.5', label: 'Kimi K2.5', family: 'Moonshot', ctx: 262000, reasoning: true, verified: 'provider' },
  { id: 'zai-org/GLM-5', alias: 'glm-5', label: 'GLM-5', family: 'Z.ai', ctx: 200000, reasoning: true, verified: 'provider' },
  { id: 'zai-org/GLM-4.7-Flash', alias: 'glm-4.7-flash', label: 'GLM-4.7 Flash', family: 'Z.ai', ctx: 200000, verified: 'provider' },
  { id: 'MiniMaxAI/MiniMax-M2.5', alias: 'minimax-m2.5', label: 'MiniMax M2.5', family: 'MiniMax', ctx: 200000, verified: 'provider' },
  { id: 'nvidia/NVIDIA-Nemotron-3-Super-120B-A12B', alias: 'nvidia-nemotron-3-super-120b-a12b', label: 'Nemotron 3 Super 120B', family: 'NVIDIA', ctx: 131000, reasoning: true, verified: 'provider' },
  { id: 'stepfun-ai/Step-3.5-Flash', alias: 'step-3.5-flash', label: 'Step 3.5 Flash', family: 'StepFun', ctx: 262000, verified: 'provider' },

  // ── Qwen3.5 family ──────────────────────────────────────────────────
  { id: 'Qwen/Qwen3.5-397B-A17B', alias: 'qwen-3.5-397b-a17b', label: 'Qwen3.5 397B A17B', family: 'Qwen', ctx: 262000, reasoning: true, verified: 'provider' },
  { id: 'Qwen/Qwen3.5-122B-A10B', alias: 'qwen-3.5-122b-a10b', label: 'Qwen3.5 122B A10B', family: 'Qwen', ctx: 262000, verified: 'provider' },
  { id: 'Qwen/Qwen3.5-35B-A3B', alias: 'qwen-3.5-35b-a3b', label: 'Qwen3.5 35B A3B', family: 'Qwen', ctx: 262000, verified: 'provider' },
  { id: 'Qwen/Qwen3.5-27B', alias: 'qwen-3.5-27b', label: 'Qwen3.5 27B', family: 'Qwen', ctx: 262000, verified: 'provider' },
  { id: 'Qwen/Qwen3.5-9B', alias: 'qwen-3.5-9b', label: 'Qwen3.5 9B', family: 'Qwen', ctx: 262000, verified: 'provider' },
  { id: 'Qwen/Qwen3.5-4B', alias: 'qwen-3.5-4b', label: 'Qwen3.5 4B', family: 'Qwen', ctx: 131000, verified: 'provider' },
  { id: 'Qwen/Qwen3.5-2B', alias: 'qwen-3.5-2b', label: 'Qwen3.5 2B', family: 'Qwen', ctx: 131000, verified: 'provider' },
  { id: 'Qwen/Qwen3.5-0.8B', alias: 'qwen-3.5-0.8b', label: 'Qwen3.5 0.8B', family: 'Qwen', ctx: 131000, verified: 'provider' },

  // ── small / fast default ────────────────────────────────────────────
  { id: 'nvidia/Nemotron-3-Nano-30B-A3B', alias: 'nemotron-3-nano-30b-a3b', label: 'Nemotron 3 Nano 30B', family: 'NVIDIA', ctx: 131000, verified: 'provider', note: 'default in DeepInfra.py' },

  // ── documented staples (safe fallbacks if the newest ones rotate out) ─
  { id: 'meta-llama/Meta-Llama-3.1-8B-Instruct', alias: 'llama-3.1-8b', label: 'Llama 3.1 8B Instruct', family: 'Meta', ctx: 131000, verified: 'docs' },
  { id: 'meta-llama/Meta-Llama-3.1-70B-Instruct', alias: 'llama-3.1-70b', label: 'Llama 3.1 70B Instruct', family: 'Meta', ctx: 131000, verified: 'docs' },
  { id: 'meta-llama/Meta-Llama-3.1-405B-Instruct', alias: 'llama-3.1-405b', label: 'Llama 3.1 405B Instruct', family: 'Meta', ctx: 131000, verified: 'docs' },
  { id: 'Qwen/Qwen2.5-72B-Instruct', alias: 'qwen2.5-72b', label: 'Qwen2.5 72B Instruct', family: 'Qwen', ctx: 32000, verified: 'docs' },
  { id: 'mistralai/Mixtral-8x22B-Instruct-v0.1', alias: 'mixtral-8x22b', label: 'Mixtral 8x22B', family: 'Mistral', ctx: 65000, verified: 'docs' },
  { id: 'mistralai/Mistral-7B-Instruct-v0.3', alias: 'mistral-7b', label: 'Mistral 7B v0.3', family: 'Mistral', ctx: 32000, verified: 'docs' },
  { id: 'google/gemma-2-27b-it', alias: 'gemma-2-27b', label: 'Gemma 2 27B IT', family: 'Google', ctx: 8000, verified: 'docs' },
  { id: 'microsoft/WizardLM-2-8x22B', alias: 'wizardlm-2-8x22b', label: 'WizardLM 2 8x22B', family: 'Microsoft', ctx: 65000, verified: 'docs' },
  { id: 'microsoft/Phi-3-medium-4k-instruct', alias: 'phi-3-medium', label: 'Phi-3 Medium 4K', family: 'Microsoft', ctx: 4000, verified: 'docs' },
  { id: 'cognitivecomputations/dolphin-2.9.1-llama-3-70b', alias: 'dolphin-2.9.1-70b', label: 'Dolphin 2.9.1 70B', family: 'Cognitive', ctx: 8000, verified: 'docs' },
  { id: 'Phind/Phind-CodeLlama-34B-v2', alias: 'phind-codellama-34b', label: 'Phind CodeLlama 34B v2', family: 'Phind', ctx: 16000, verified: 'docs' },
  { id: 'openchat/openchat-3.6-8b', alias: 'openchat-3.6-8b', label: 'OpenChat 3.6 8B', family: 'OpenChat', ctx: 8000, verified: 'docs' },
  { id: 'lizpreciatior/lzlv_70b_fp16_hf', alias: 'lzlv-70b', label: 'LZLV 70B fp16', family: 'Community', ctx: 4000, verified: 'docs' },
  { id: 'openbmb/MiniCPM-Llama3-V-2_5', alias: 'minicpm-llama3-v2.5', label: 'MiniCPM Llama3 V 2.5', family: 'OpenBMB', ctx: 8000, vision: true, verified: 'docs' },
  { id: 'deepseek-ai/DeepSeek-V4-Flash-0731', alias: 'deepseek-v4-flash', label: 'DeepSeek V4 Flash', family: 'DeepSeek', ctx: 163000, verified: 'docs' },
]

export const CATALOG_BY_ID = new Map(CATALOG.map((m) => [m.id, m]))

export function lookupModel(id) {
  return CATALOG_BY_ID.get(id) ?? null
}

export function labelFor(id) {
  return CATALOG_BY_ID.get(id)?.label ?? id
}

/** Turn GET /v1/openai/models into a Set of live ids. */
export function parseModelsResponse(json) {
  const rows = Array.isArray(json?.data) ? json.data : Array.isArray(json) ? json : []
  return rows
    .map((r) => (typeof r === 'string' ? r : r?.id))
    .filter((id) => typeof id === 'string' && id.includes('/'))
}
