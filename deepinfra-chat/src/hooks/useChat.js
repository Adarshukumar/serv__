/**
 * ══════════════════════════════════════════════════════════════════
 *  useChat — the whole app state machine
 * ══════════════════════════════════════════════════════════════════
 *  conversations · streaming · retries · diagnostics · toasts
 *  Token chunks are batched into one paint per animation frame, so a fast
 *  stream never janks the UI.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { streamChat } from '../lib/deepinfra/transport.js'
import { resolveModel, CATALOG, parseModelsResponse } from '../lib/deepinfra/models.js'
import { PROXY_BASE } from '../lib/deepinfra/headers.js'
import { load, save, uid, exportConversation, downloadText } from '../lib/storage.js'

export const DEFAULT_SETTINGS = {
  model: 'nvidia/Nemotron-3-Nano-30B-A3B',
  mode: 'auto',
  apiKey: '',
  temperature: 0.7,
  maxTokens: 2048,
  topP: 1,
  retries: 2,
  system: 'You are Nova, a helpful, precise assistant. Answer in markdown.',
  showReasoning: true,
  telemetry: true,
}

const MAX_LOG_LINES = 200

function freshConversation(model) {
  return {
    id: uid('chat'),
    title: 'New chat',
    model,
    createdAt: Date.now(),
    messages: [],
  }
}

export function useChat() {
  const [conversations, setConversations] = useState(() => load('conversations', []))
  const [activeId, setActiveId] = useState(() => load('activeId', null))
  const [settings, setSettings] = useState(() => ({ ...DEFAULT_SETTINGS, ...load('settings', {}) }))
  const [streaming, setStreaming] = useState(false)
  const [logs, setLogs] = useState([])
  const [toasts, setToasts] = useState([])
  const [lastRun, setLastRun] = useState(null)
  const [liveModels, setLiveModels] = useState(() => load('liveModels', null))
  const [proxyHealth, setProxyHealth] = useState(null)
  const [drawer, setDrawer] = useState(null) // 'settings' | 'diagnostics' | null

  const abortRef = useRef(null)
  const bufRef = useRef({ content: '', reasoning: '' })
  const rafRef = useRef(0)
  const fullRef = useRef({ content: '', reasoning: '' })
  const nearBottomRef = useRef(true)

  const active = useMemo(
    () => conversations.find((c) => c.id === activeId) ?? conversations[0] ?? null,
    [conversations, activeId],
  )

  // ── persistence ───────────────────────────────────────────────────
  useEffect(() => {
    save('conversations', conversations.slice(0, 40))
  }, [conversations])
  useEffect(() => {
    save('activeId', activeId)
  }, [activeId])
  useEffect(() => {
    save('settings', settings)
  }, [settings])
  useEffect(() => {
    if (liveModels) save('liveModels', liveModels)
  }, [liveModels])

  // ── helpers ───────────────────────────────────────────────────────
  const pushLog = useCallback(
    (level, text) => {
      if (!settings.telemetry && level !== 'error') return
      setLogs((prev) => {
        const stamp = new Date().toLocaleTimeString([], { hour12: false })
        const next = [...prev, { id: uid('log'), level, text, stamp }]
        return next.length > MAX_LOG_LINES ? next.slice(-MAX_LOG_LINES) : next
      })
    },
    [settings.telemetry],
  )

  const toast = useCallback((kind, title, body = '') => {
    const id = uid('toast')
    setToasts((prev) => [...prev, { id, kind, title, body }])
    setTimeout(() => setToasts((prev) => prev.filter((t) => t.id !== id)), kind === 'error' ? 9000 : 4500)
  }, [])

  const dismissToast = useCallback((id) => setToasts((prev) => prev.filter((t) => t.id !== id)), [])

  const patchMessage = useCallback((convoId, msgId, patch) => {
    setConversations((prev) =>
      prev.map((c) =>
        c.id !== convoId
          ? c
          : {
              ...c,
              messages: c.messages.map((m) => (m.id === msgId ? { ...m, ...patch } : m)),
            },
      ),
    )
  }, [])

  const scheduleFlush = useCallback(
    (convoId, msgId) => {
      if (rafRef.current) return
      rafRef.current = requestAnimationFrame(() => {
        rafRef.current = 0
        const { content, reasoning } = bufRef.current
        if (!content && !reasoning) return
        bufRef.current = { content: '', reasoning: '' }
        setConversations((prev) =>
          prev.map((c) =>
            c.id !== convoId
              ? c
              : {
                  ...c,
                  messages: c.messages.map((m) =>
                    m.id !== msgId
                      ? m
                      : { ...m, content: m.content + content, reasoning: m.reasoning + reasoning },
                  ),
                },
          ),
        )
      })
    },
    [],
  )

  // ── conversations ─────────────────────────────────────────────────
  const newChat = useCallback(() => {
    const convo = freshConversation(settings.model)
    setConversations((prev) => [convo, ...prev])
    setActiveId(convo.id)
    setDrawer(null)
    return convo
  }, [settings.model])

  const deleteChat = useCallback(
    (id) => {
      setConversations((prev) => {
        const next = prev.filter((c) => c.id !== id)
        setActiveId((cur) => (cur === id ? next[0]?.id ?? null : cur))
        return next
      })
    },
    [],
  )

  const renameChat = useCallback((id, title) => {
    setConversations((prev) => prev.map((c) => (c.id === id ? { ...c, title: title || c.title } : c)))
  }, [])

  const clearHistory = useCallback((id) => {
    setConversations((prev) =>
      prev.map((c) => (c.id === id ? { ...c, messages: [], title: 'New chat' } : c)),
    )
  }, [])

  const clearLogs = useCallback(() => setLogs([]), [])

  const clearAll = useCallback(() => {
    setConversations([])
    setActiveId(null)
    setLogs([])
    toast('ok', 'Everything cleared')
  }, [toast])

  const exportActive = useCallback(() => {
    if (!active) return
    downloadText(`${active.title.replace(/[^\w-]+/g, '_') || 'chat'}.md`, exportConversation(active))
    toast('ok', 'Exported as markdown')
  }, [active, toast])

  // ── the send loop ─────────────────────────────────────────────────
  const stop = useCallback(() => {
    abortRef.current?.abort()
    abortRef.current = null
    setStreaming(false)
    pushLog('warn', 'aborted by user')
  }, [pushLog])

  const runTurn = useCallback(
    async ({ convoId, history, model, mode }) => {
      const assistantId = uid('msg')
      setConversations((prev) =>
        prev.map((c) =>
          c.id !== convoId
            ? c
            : {
                ...c,
                messages: [
                  ...c.messages,
                  {
                    id: assistantId,
                    role: 'assistant',
                    content: '',
                    reasoning: '',
                    model,
                    mode,
                    status: 'streaming',
                    createdAt: Date.now(),
                  },
                ],
              },
        ),
      )

      const ctrl = new AbortController()
      abortRef.current = ctrl
      fullRef.current = { content: '', reasoning: '' }
      bufRef.current = { content: '', reasoning: '' }

      let currentRung = null

      try {
        const result = await streamChat({
          messages: history,
          model,
          mode,
          apiKey: settings.apiKey.trim(),
          temperature: Number(settings.temperature),
          maxTokens: Number(settings.maxTokens),
          topP: Number(settings.topP),
          retries: Number(settings.retries),
          signal: ctrl.signal,
          onDelta: (chunk) => {
            fullRef.current.content += chunk
            bufRef.current.content += chunk
            scheduleFlush(convoId, assistantId)
          },
          onReasoning: (chunk) => {
            fullRef.current.reasoning += chunk
            bufRef.current.reasoning += chunk
            scheduleFlush(convoId, assistantId)
          },
          onLog: (e) => pushLog(e.level, e.text),
          onRung: (r) => {
            currentRung = r
            if (r.index > 1) {
              pushLog('info', `falling forward: ${r.label}`)
              toast('warn', 'Falling back', r.label)
            }
          },
        })

        // make sure the final frame is painted before we freeze the message
        if (rafRef.current) cancelAnimationFrame(rafRef.current)
        rafRef.current = 0
        bufRef.current = { content: '', reasoning: '' }

        patchMessage(convoId, assistantId, {
          content: result.content || fullRef.current.content,
          reasoning: result.reasoning || fullRef.current.reasoning,
          status: 'done',
          usage: result.usage,
          ttfbMs: result.ttfbMs,
          totalMs: result.totalMs,
          rung: result.rung?.id,
        })

        setLastRun({
          at: Date.now(),
          model,
          mode,
          rung: result.rung?.label ?? currentRung?.label ?? '—',
          rungId: result.rung?.id,
          ttfbMs: result.ttfbMs,
          totalMs: result.totalMs,
          usage: result.usage,
          attempts: result.attempts ?? [],
          chars: result.content?.length ?? 0,
        })
        pushLog('ok', `done in ${result.totalMs} ms · ttfb ${result.ttfbMs} ms`)
      } catch (err) {
        if (rafRef.current) cancelAnimationFrame(rafRef.current)
        rafRef.current = 0
        bufRef.current = { content: '', reasoning: '' }

        const aborted = err?.kind === 'abort' || err?.name === 'AbortError'
        patchMessage(convoId, assistantId, {
          content: fullRef.current.content,
          reasoning: fullRef.current.reasoning,
          status: aborted ? 'stopped' : 'error',
          error: aborted
            ? null
            : {
                title: err?.title ?? 'Request failed',
                message: err?.message ?? String(err),
                hint: err?.hint ?? '',
                kind: err?.kind ?? 'unknown',
                status: err?.status ?? 0,
              },
        })
        if (!aborted) {
          pushLog('error', `${err?.title ?? 'error'}: ${err?.message ?? err}`)
          toast('error', err?.title ?? 'Request failed', err?.hint || err?.message || '')
        }
        setLastRun((prev) => ({
          ...(prev ?? {}),
          at: Date.now(),
          model,
          mode,
          rung: 'failed',
          error: err?.title ?? String(err),
          attempts: err?.attempts ?? [],
        }))
      } finally {
        abortRef.current = null
        setStreaming(false)
      }
    },
    [patchMessage, pushLog, scheduleFlush, settings, toast],
  )

  const send = useCallback(
    async (text) => {
      const prompt = text.trim()
      if (!prompt || streaming) return

      let convo = active
      if (!convo) {
        convo = freshConversation(settings.model)
        setConversations([convo])
        setActiveId(convo.id)
      }

      const userMsg = { id: uid('msg'), role: 'user', content: prompt, createdAt: Date.now() }
      const history = [
        ...(settings.system ? [{ role: 'system', content: settings.system }] : []),
        ...convo.messages
          .filter((m) => m.status !== 'error' && m.content)
          .map((m) => ({ role: m.role, content: m.content })),
        { role: 'user', content: prompt },
      ]

      setConversations((prev) =>
        prev.map((c) =>
          c.id !== convo.id
            ? c
            : {
                ...c,
                title: c.messages.length === 0 ? prompt.slice(0, 42) : c.title,
                model: settings.model,
                messages: [...c.messages, userMsg],
              },
        ),
      )
      setStreaming(true)
      setDrawer(null)
      await runTurn({ convoId: convo.id, history, model: settings.model, mode: settings.mode })
    },
    [active, runTurn, settings.model, settings.mode, settings.system, streaming],
  )

  const regenerate = useCallback(async () => {
    if (!active || streaming) return
    const msgs = [...active.messages]
    while (msgs.length && msgs[msgs.length - 1].role === 'assistant') msgs.pop()
    const lastUser = msgs[msgs.length - 1]
    if (!lastUser || lastUser.role !== 'user') return

    const history = [
      ...(settings.system ? [{ role: 'system', content: settings.system }] : []),
      ...msgs.slice(0, -1).filter((m) => m.content).map((m) => ({ role: m.role, content: m.content })),
      { role: 'user', content: lastUser.content },
    ]

    setConversations((prev) => prev.map((c) => (c.id === active.id ? { ...c, messages: msgs } : c)))
    setStreaming(true)
    await runTurn({ convoId: active.id, history, model: settings.model, mode: settings.mode })
  }, [active, runTurn, settings.model, settings.mode, settings.system, streaming])

  // ── settings / diagnostics ────────────────────────────────────────
  const updateSettings = useCallback((patch) => {
    setSettings((prev) => ({ ...prev, ...patch }))
  }, [])

  const checkProxy = useCallback(async () => {
    try {
      const res = await fetch(`${PROXY_BASE}/health`)
      const json = await res.json()
      setProxyHealth({ ...json, checkedAt: Date.now() })
      pushLog('ok', `proxy health: ${JSON.stringify(json)}`)
      return json
    } catch (err) {
      setProxyHealth({ ok: false, error: String(err?.message ?? err), checkedAt: Date.now() })
      pushLog('error', `proxy health failed: ${err?.message ?? err}`)
      return null
    }
  }, [pushLog])

  const syncModels = useCallback(async () => {
    pushLog('info', 'syncing model catalogue…')
    const urls = [`${PROXY_BASE}/v1/models`, 'https://api.deepinfra.com/v1/openai/models']
    for (const url of urls) {
      try {
        const res = await fetch(url)
        if (!res.ok) throw new Error(`HTTP ${res.status}`)
        const json = await res.json()
        const ids = parseModelsResponse(json)
        if (!ids.length) throw new Error('empty catalogue')
        setLiveModels({ ids, at: Date.now(), via: url })
        pushLog('ok', `catalogue: ${ids.length} live models (via ${url})`)
        toast('ok', `${ids.length} models available`, 'Catalogue synced from DeepInfra.')
        return ids
      } catch (err) {
        pushLog('warn', `sync via ${url} failed: ${err.message}`)
      }
    }
    toast('error', 'Could not sync models', 'Open Diagnostics and run npm run doctor.')
    return null
  }, [pushLog, toast])

  const modelIsLive = useCallback(
    (id) => (liveModels?.ids ? liveModels.ids.includes(id) : null),
    [liveModels],
  )

  const resolvedModelPreview = useMemo(() => resolveModel(settings.model), [settings.model])

  const suggestedModels = useMemo(() => CATALOG, [])

  return {
    conversations,
    active,
    activeId,
    setActiveId,
    settings,
    updateSettings,
    streaming,
    send,
    stop,
    regenerate,
    newChat,
    deleteChat,
    renameChat,
    clearAll,
    clearHistory,
    clearLogs,
    exportActive,
    logs,
    pushLog,
    toasts,
    toast,
    dismissToast,
    lastRun,
    drawer,
    setDrawer,
    liveModels,
    syncModels,
    modelIsLive,
    resolvedModelPreview,
    suggestedModels,
    proxyHealth,
    checkProxy,
  }
}
