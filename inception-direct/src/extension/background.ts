/**
 * Service worker. Deliberately tiny: it never talks to Inception itself — all
 * requests are made by the app page (or the site tab), in the user's browser.
 *
 * - Toolbar button → open the chat (or focus it if it's already open).
 * - Install/startup → register the Origin/Referer header rule for our own requests.
 */
import { installHeaderRules } from '../platform/headerRules';
import { BASE_URL } from '../platform/env';

const APP_PAGE = 'index.html';

async function openApp(): Promise<void> {
  const url = chrome.runtime.getURL(APP_PAGE);
  try {
    const contexts = await chrome.runtime.getContexts({
      contextTypes: ['TAB' as chrome.runtime.ContextType],
    });
    const existing = contexts.find((c) => c.tabId >= 0 && (c.documentUrl ?? '').startsWith(url));
    if (existing) {
      await chrome.tabs.update(existing.tabId, { active: true });
      if (existing.windowId >= 0) await chrome.windows.update(existing.windowId, { focused: true });
      return;
    }
  } catch {
    // getContexts unavailable (older browser) — just open a new tab.
  }
  await chrome.tabs.create({ url });
}

chrome.action.onClicked.addListener(() => {
  void openApp();
});

chrome.runtime.onInstalled.addListener((details) => {
  void installHeaderRules(BASE_URL);
  if (details.reason === 'install') void openApp();
});

chrome.runtime.onStartup.addListener(() => {
  void installHeaderRules(BASE_URL);
});
