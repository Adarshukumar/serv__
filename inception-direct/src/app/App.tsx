import { useEffect, useRef } from 'react';
import { init, newChat, store } from './controller';
import { useStore } from './store';
import { applySettings } from './theme';
import { Composer } from './components/Composer';
import { ConnectionPanel } from './components/ConnectionPanel';
import { Conversation } from './components/Conversation';
import { Masthead } from './components/Masthead';
import { SettingsSheet } from './components/SettingsSheet';
import { Sidebar } from './components/Sidebar';
import { TopBar } from './components/TopBar';

export function App() {
  const settings = useStore(store, (s) => s.settings);
  const hasMessages = useStore(store, (s) => (s.active?.messages.length ?? 0) > 0);
  const scroller = useRef<HTMLDivElement>(null);

  useEffect(() => {
    applySettings(settings);
  }, [settings]);

  useEffect(() => {
    void init();
  }, []);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.shiftKey && event.key.toLowerCase() === 'o') {
        event.preventDefault();
        newChat();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  return (
    <div className="app">
      <Sidebar />
      <main className="main">
        <TopBar />
        <div className="scroller" ref={scroller}>
          <div className={hasMessages ? 'column' : 'column column--empty'}>
            {hasMessages ? (
              <>
                <ConnectionPanel />
                <Conversation scroller={scroller} />
              </>
            ) : (
              <>
                <Masthead />
                <ConnectionPanel />
              </>
            )}
          </div>
        </div>
        <Composer />
      </main>
      <SettingsSheet />
    </div>
  );
}
