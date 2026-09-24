/**
 * declarativeNetRequest rule that makes the extension's own requests to
 * <base>/api/* carry the site's Origin and Referer — exactly what the web app sends —
 * instead of chrome-extension://<id>.
 *
 * Scoped with `initiatorDomains: [<extension id>]`, so it only touches requests this
 * extension makes. It never rewrites requests from web pages (that would weaken the
 * site's CSRF protection for the user).
 */
export const HEADER_RULE_ID = 4201;

type Rule = chrome.declarativeNetRequest.Rule;

export function buildHeaderRule(baseUrl: string, extensionId: string): Rule {
  const origin = new URL(baseUrl).origin;
  return {
    id: HEADER_RULE_ID,
    priority: 1,
    action: {
      type: 'modifyHeaders' as chrome.declarativeNetRequest.RuleActionType,
      requestHeaders: [
        { header: 'Origin', operation: 'set' as chrome.declarativeNetRequest.HeaderOperation, value: origin },
        { header: 'Referer', operation: 'set' as chrome.declarativeNetRequest.HeaderOperation, value: `${origin}/` },
      ],
    },
    condition: {
      urlFilter: `|${origin}/api/`,
      initiatorDomains: [extensionId],
      resourceTypes: ['xmlhttprequest' as chrome.declarativeNetRequest.ResourceType],
    },
  };
}

/**
 * Install (or re-install) the rule as a session rule. Session rules survive until the
 * browser restarts; the service worker re-installs them on startup, and the app page
 * calls this before its first request. Idempotent.
 */
export async function installHeaderRules(baseUrl: string): Promise<boolean> {
  const dnr = typeof chrome !== 'undefined' ? chrome.declarativeNetRequest : undefined;
  if (!dnr?.updateSessionRules || !chrome.runtime?.id) return false;
  try {
    await dnr.updateSessionRules({
      removeRuleIds: [HEADER_RULE_ID],
      addRules: [buildHeaderRule(baseUrl, chrome.runtime.id)],
    });
    return true;
  } catch (error) {
    console.warn('[inception-direct] could not install header rules:', error);
    return false;
  }
}
