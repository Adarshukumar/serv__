/**
 * Tiny, defensive localStorage layer — the app must never crash because
 * storage is disabled (private mode / embedded iframe / SSR-ish contexts).
 */

const PREFIX = 'novachat.v1.'

export function load(key, fallback) {
  try {
    const raw = localStorage.getItem(PREFIX + key)
    if (!raw) return fallback
    return JSON.parse(raw)
  } catch {
    return fallback
  }
}

export function save(key, value) {
  try {
    localStorage.setItem(PREFIX + key, JSON.stringify(value))
    return true
  } catch {
    return false
  }
}

export function remove(key) {
  try {
    localStorage.removeItem(PREFIX + key)
  } catch {
    /* noop */
  }
}

export function uid(prefix = 'id') {
  const rand =
    typeof crypto !== 'undefined' && crypto.randomUUID
      ? crypto.randomUUID().slice(0, 8)
      : Math.random().toString(36).slice(2, 10)
  return `${prefix}_${Date.now().toString(36)}_${rand}`
}

export function exportConversation(convo) {
  const lines = [
    `# ${convo.title}`,
    '',
    `_model: ${convo.model} · exported ${new Date().toISOString()}_`,
    '',
    ...convo.messages.flatMap((m) => [
      `## ${m.role === 'user' ? 'You' : 'Assistant'}`,
      '',
      m.reasoning ? `> thinking\n> ${m.reasoning.replace(/\n/g, '\n> ')}\n` : '',
      m.content,
      '',
    ]),
  ]
  return lines.join('\n')
}

export function downloadText(filename, text) {
  const blob = new Blob([text], { type: 'text/markdown;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  a.click()
  setTimeout(() => URL.revokeObjectURL(url), 2000)
}
