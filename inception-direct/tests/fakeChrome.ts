/**
 * A small, faithful-enough fake of the chrome.* APIs used by the extension:
 * tabs (query/create/get/update/remove/getCurrent/sendMessage/connect), runtime
 * (id, onMessage, onConnect) and declarativeNetRequest.updateSessionRules.
 *
 * Port messages are JSON round-tripped and delivered asynchronously, like Chrome.
 */

type Listener<T extends unknown[]> = (...args: T) => unknown;

class Event<T extends unknown[]> {
  listeners: Listener<T>[] = [];
  addListener(fn: Listener<T>) {
    this.listeners.push(fn);
  }
  removeListener(fn: Listener<T>) {
    this.listeners = this.listeners.filter((l) => l !== fn);
  }
  emit(...args: T) {
    for (const l of [...this.listeners]) l(...args);
  }
}

export interface FakePort {
  name: string;
  onMessage: Event<[unknown]>;
  onDisconnect: Event<[]>;
  postMessage(message: unknown): void;
  disconnect(): void;
}

function portPair(name: string): [FakePort, FakePort] {
  let a!: FakePort;
  let b!: FakePort;
  let open = true;
  const make = (other: () => FakePort): FakePort => ({
    name,
    onMessage: new Event<[unknown]>(),
    onDisconnect: new Event<[]>(),
    postMessage(message: unknown) {
      if (!open) throw new Error('Attempting to use a disconnected port object');
      const copy = JSON.parse(JSON.stringify(message)) as unknown;
      queueMicrotask(() => open && other().onMessage.emit(copy));
    },
    disconnect() {
      if (!open) return;
      open = false;
      queueMicrotask(() => other().onDisconnect.emit());
    },
  });
  a = make(() => b);
  b = make(() => a);
  return [a, b];
}

export function createFakeChrome(options: { extensionId?: string; appTabId?: number } = {}) {
  const tabs = new Map<number, { id: number; url: string; active: boolean; lastAccessed: number }>();
  let nextTabId = 100;
  const appTabId = options.appTabId ?? 1;
  tabs.set(appTabId, { id: appTabId, url: 'chrome-extension://ext/index.html', active: true, lastAccessed: 1 });

  const onMessage = new Event<[unknown, unknown, (response: unknown) => void]>();
  const onConnect = new Event<[FakePort]>();
  const sessionRules: unknown[] = [];
  const log: string[] = [];
  /** Tabs whose content script is "loaded" (can receive messages). */
  const scriptReady = new Set<number>();
  let lastContentPort: FakePort | null = null;

  const chrome = {
    runtime: {
      id: options.extensionId ?? 'abcdefghijklmnopabcdefghijklmnop',
      onMessage,
      onConnect,
    },
    tabs: {
      async query(filter: { url?: string }) {
        const prefix = (filter.url ?? '').replace(/\*$/, '');
        return [...tabs.values()].filter((t) => t.url.startsWith(prefix));
      },
      async create(props: { url: string; active?: boolean }) {
        const tab = { id: nextTabId++, url: props.url, active: props.active ?? true, lastAccessed: Date.now() };
        tabs.set(tab.id, tab);
        log.push(`create ${tab.id} ${props.url} active=${tab.active}`);
        return { ...tab };
      },
      async get(id: number) {
        const tab = tabs.get(id);
        if (!tab) throw new Error(`No tab with id: ${id}`);
        return { ...tab };
      },
      async update(id: number, props: { active?: boolean }) {
        const tab = tabs.get(id);
        if (tab && props.active !== undefined) tab.active = props.active;
        log.push(`update ${id} ${JSON.stringify(props)}`);
        return tab ? { ...tab } : undefined;
      },
      async remove(id: number) {
        tabs.delete(id);
        scriptReady.delete(id);
        log.push(`remove ${id}`);
      },
      async getCurrent() {
        return { ...tabs.get(appTabId)! };
      },
      async sendMessage(tabId: number, message: unknown) {
        if (!tabs.has(tabId) || !scriptReady.has(tabId)) {
          throw new Error('Could not establish connection. Receiving end does not exist.');
        }
        return new Promise((resolve) => {
          let handled = false;
          for (const listener of onMessage.listeners) {
            const keepOpen = listener(JSON.parse(JSON.stringify(message)), { tab: { id: tabId } }, (response: unknown) => {
              handled = true;
              resolve(response);
            });
            if (keepOpen === true || handled) return;
          }
          resolve(undefined);
        });
      },
      connect(tabId: number, info: { name: string }) {
        const [appSide, contentSide] = portPair(info.name);
        log.push(`connect ${tabId} ${info.name}`);
        lastContentPort = contentSide;
        queueMicrotask(() => onConnect.emit(contentSide));
        return appSide;
      },
    },
    declarativeNetRequest: {
      async updateSessionRules(update: { removeRuleIds?: number[]; addRules?: unknown[] }) {
        sessionRules.length = 0;
        sessionRules.push(...(update.addRules ?? []));
        log.push(`rules remove=${JSON.stringify(update.removeRuleIds)} add=${update.addRules?.length ?? 0}`);
      },
    },
  };

  return {
    chrome,
    tabs,
    log,
    sessionRules,
    /** Mark a tab's content script as loaded (after "page load"). */
    loadScript(tabId: number) {
      scriptReady.add(tabId);
    },
    get lastContentPort() {
      return lastContentPort;
    },
  };
}
