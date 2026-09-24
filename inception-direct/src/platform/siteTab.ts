import { InceptionError } from '../core/errors';
import { sleep } from '../core/http';
import { PROBE_MESSAGE, type ProbeResult } from './bridgeProtocol';

/**
 * Helpers for working with a real chat.inceptionlabs.ai tab: asking its content
 * script whether the site is usable, and waiting for a security check to finish.
 */

/** Ask the content script in `tabId` whether the site (and its /api/session) is reachable. */
export async function probeTab(tabId: number): Promise<ProbeResult | null> {
  try {
    const reply = (await chrome.tabs.sendMessage(tabId, { t: PROBE_MESSAGE })) as ProbeResult | undefined;
    return reply && typeof reply.ready === 'boolean' ? reply : null;
  } catch {
    // No content script yet (page still loading) or the tab is gone.
    return null;
  }
}

export interface WaitOptions {
  timeoutMs: number;
  intervalMs?: number;
  signal?: AbortSignal;
  /** Called after every probe, e.g. to show "still on the checkpoint…" */
  onProbe?: (result: ProbeResult | null, elapsedMs: number) => void;
}

/** Poll until the tab reports ready. Throws if the tab closes, the wait is aborted or times out. */
export async function waitUntilReady(tabId: number, options: WaitOptions): Promise<void> {
  const started = Date.now();
  const interval = options.intervalMs ?? 1200;
  for (;;) {
    if (options.signal?.aborted) throw new InceptionError('aborted', 'Security check cancelled.');
    const tab = await chrome.tabs.get(tabId).catch(() => null);
    if (!tab) throw new InceptionError('aborted', 'The chat.inceptionlabs.ai tab was closed before the check finished.');
    const result = await probeTab(tabId);
    const elapsed = Date.now() - started;
    options.onProbe?.(result, elapsed);
    if (result?.ready) return;
    if (elapsed > options.timeoutMs) {
      throw new InceptionError('challenge', 'Timed out waiting for chat.inceptionlabs.ai to finish its security check.');
    }
    await sleep(interval, options.signal);
  }
}

/** Existing tabs on the site, most recently used first. */
export async function findSiteTabs(baseUrl: string): Promise<chrome.tabs.Tab[]> {
  const pattern = `${new URL(baseUrl).origin}/*`;
  try {
    const tabs = await chrome.tabs.query({ url: pattern });
    return tabs.filter((t) => typeof t.id === 'number').sort((a, b) => (b.lastAccessed ?? 0) - (a.lastAccessed ?? 0));
  } catch {
    return [];
  }
}

export interface SecurityCheckOptions {
  signal?: AbortSignal;
  onProbe?: WaitOptions['onProbe'];
  timeoutMs?: number;
}

/**
 * Let the browser pass Inception's bot checkpoint: open the site in a tab (the
 * checkpoint's JavaScript runs there, in the user's real browser, and stores its
 * clearance cookie), wait until the site answers, then close the tab and come back.
 */
export async function runSecurityCheck(baseUrl: string, options: SecurityCheckOptions = {}): Promise<void> {
  const appTab = await chrome.tabs.getCurrent().catch(() => undefined);
  const tab = await chrome.tabs.create({
    url: `${baseUrl}/`,
    active: true,
    ...(appTab?.id !== undefined ? { openerTabId: appTab.id } : {}),
  });
  if (tab.id === undefined) throw new InceptionError('challenge', 'Could not open chat.inceptionlabs.ai.');
  try {
    await waitUntilReady(tab.id, {
      timeoutMs: options.timeoutMs ?? 180_000,
      signal: options.signal,
      onProbe: options.onProbe,
    });
  } finally {
    await chrome.tabs.remove(tab.id).catch(() => {});
    if (appTab?.id !== undefined) await chrome.tabs.update(appTab.id, { active: true }).catch(() => {});
  }
}
