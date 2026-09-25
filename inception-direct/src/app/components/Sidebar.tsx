import { useMemo } from 'react';
import { deleteChat, newChat, selectChat, store } from '../controller';
import { groupConversations } from '../format';
import { useStore } from '../store';
import { MercuryGlyph } from './Glyph';
import { CloseIcon, PlusIcon, TrashIcon } from './Icons';

const VERSION = typeof __APP_VERSION__ === 'string' ? __APP_VERSION__ : 'dev';

export function Sidebar() {
  const list = useStore(store, (s) => s.list);
  const activeId = useStore(store, (s) => s.active?.id ?? null);
  const open = useStore(store, (s) => s.ui.sidebarOpen);
  const groups = useMemo(() => groupConversations(list), [list]);

  return (
    <>
      <aside className="sidebar" data-open={open} aria-label="Conversations">
        <div className="brand">
          <span className="brand-glyph" aria-hidden="true">
            <MercuryGlyph size={24} accent="var(--accent)" stroke={1.8} />
          </span>
          <div>
            <div className="brand-name">Mercury</div>
            <div className="brand-sub">Inception · Direct</div>
          </div>
          <button
            type="button"
            className="icon-button sidebar-close"
            onClick={() => store.set((s) => ({ ...s, ui: { ...s.ui, sidebarOpen: false } }))}
            aria-label="Close sidebar"
          >
            <CloseIcon />
          </button>
        </div>

        <button type="button" className="new-chat" onClick={newChat}>
          <PlusIcon size={16} />
          <span>New conversation</span>
        </button>

        <nav className="conversation-list">
          {groups.length === 0 ? (
            <p className="list-empty">Your conversations will be listed here — kept only in this browser.</p>
          ) : (
            groups.map((group) => (
              <section key={group.label}>
                <h3 className="list-heading">{group.label}</h3>
                <ul>
                  {group.items.map((item) => (
                    <li key={item.id} className="list-item" data-active={item.id === activeId}>
                      <button type="button" className="list-title" onClick={() => void selectChat(item.id)} title={item.title}>
                        {item.title}
                      </button>
                      <button
                        type="button"
                        className="list-delete"
                        onClick={() => void deleteChat(item.id)}
                        aria-label={`Delete “${item.title}”`}
                        title="Delete"
                      >
                        <TrashIcon size={15} />
                      </button>
                    </li>
                  ))}
                </ul>
              </section>
            ))
          )}
        </nav>

        <footer className="sidebar-foot">
          <p>No servers in between: this page talks to Inception’s API directly, over your own connection. Chats and key stay on this device.</p>
          <p className="sidebar-version">v{VERSION}</p>
        </footer>
      </aside>
      <div
        className="scrim"
        data-open={open}
        onClick={() => store.set((s) => ({ ...s, ui: { ...s.ui, sidebarOpen: false } }))}
        aria-hidden="true"
      />
    </>
  );
}
