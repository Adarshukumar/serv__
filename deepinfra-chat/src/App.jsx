import { useCallback, useEffect, useState } from 'react'
import { useChat } from './hooks/useChat.js'
import Sidebar from './components/Sidebar.jsx'
import TopBar from './components/TopBar.jsx'
import MessageList from './components/MessageList.jsx'
import Composer from './components/Composer.jsx'
import Drawer from './components/Drawer.jsx'
import Toasts from './components/Toasts.jsx'

export default function App() {
  const chat = useChat()
  const [sidebarOpen, setSidebarOpen] = useState(false)

  const {
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
    dismissToast,
    lastRun,
    drawer,
    setDrawer,
    liveModels,
    syncModels,
    modelIsLive,
    proxyHealth,
    checkProxy,
  } = chat

  // ── keyboard shortcuts ────────────────────────────────────────────
  const onGlobalKey = useCallback(
    (e) => {
      const mod = e.metaKey || e.ctrlKey
      if (mod && e.key.toLowerCase() === 'k') {
        e.preventDefault()
        newChat()
        setSidebarOpen(false)
      }
      if (mod && e.key === '/') {
        e.preventDefault()
        setDrawer('settings')
      }
      if (mod && e.key.toLowerCase() === 'i') {
        e.preventDefault()
        setDrawer('diagnostics')
      }
    },
    [newChat, setDrawer],
  )

  useEffect(() => {
    window.addEventListener('keydown', onGlobalKey)
    return () => window.removeEventListener('keydown', onGlobalKey)
  }, [onGlobalKey])

  // quiet first-load probe of the local proxy so diagnostics isn't empty
  useEffect(() => {
    checkProxy()
    pushLog('info', 'NovaChat ready — Auto ladder armed (direct → proxy)')
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  return (
    <div className="app">
      {/* animated background */}
      <div className="aurora" aria-hidden>
        <i className="blob b1" />
        <i className="blob b2" />
        <i className="blob b3" />
        <div className="grid-overlay" />
        <div className="vignette" />
      </div>

      <div className={`shell ${sidebarOpen ? 'sidebar-open' : ''}`}>
        <div className="sidebar-slot">
          <Sidebar
            conversations={conversations}
            activeId={activeId}
            setActiveId={(id) => {
              setActiveId(id)
              setSidebarOpen(false)
            }}
            onNew={() => {
              newChat()
              setSidebarOpen(false)
            }}
            onDelete={deleteChat}
            onRename={renameChat}
            settings={settings}
            updateSettings={updateSettings}
            onOpenDrawer={setDrawer}
            liveModels={liveModels}
            modelIsLive={modelIsLive}
            onExport={exportActive}
            streaming={streaming}
          />
        </div>

        <main className="stage">
          <TopBar
            active={active}
            settings={settings}
            lastRun={lastRun}
            streaming={streaming}
            onRename={renameChat}
            onSync={syncModels}
            onOpenDrawer={setDrawer}
            liveModels={liveModels}
          />

          <button className="mobile-bar" onClick={() => setSidebarOpen((v) => !v)}>
            <span>☰</span> {active?.title ?? 'NovaChat'}
          </button>

          <MessageList
            messages={active?.messages ?? []}
            active={active}
            streaming={streaming}
            onRegenerate={regenerate}
            onOpenDrawer={setDrawer}
            settings={settings}
            onPick={(text) => send(text)}
          />

          <Composer
            onSend={send}
            onStop={stop}
            streaming={streaming}
            settings={settings}
            onClearHistory={() => active && clearHistory(active.id)}
            hasMessages={Boolean(active?.messages?.length)}
          />
        </main>
      </div>

      <Drawer
        tab={drawer}
        onClose={() => setDrawer(null)}
        settings={settings}
        updateSettings={updateSettings}
        logs={logs}
        clearLogs={clearLogs}
        lastRun={lastRun}
        liveModels={liveModels}
        modelIsLive={modelIsLive}
        syncModels={syncModels}
        onClearAll={clearAll}
        proxyHealth={proxyHealth}
        checkProxy={checkProxy}
      />

      <Toasts toasts={toasts} onDismiss={dismissToast} />
    </div>
  )
}
