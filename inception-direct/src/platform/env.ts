import { normaliseBaseUrl } from '../core/config';

/**
 * Where Inception lives. Overridable at build time (VITE_INCEPTION_BASE_URL) so the
 * test-suite can point a build at a local protocol simulator; real builds use
 * https://chat.inceptionlabs.ai.
 */
export const BASE_URL = normaliseBaseUrl(import.meta.env.VITE_INCEPTION_BASE_URL as string | undefined);

export const BASE_ORIGIN = new URL(BASE_URL).origin;
export const BASE_HOST = new URL(BASE_URL).host;

/** True when running as an extension page (chrome-extension://…), where host permissions apply. */
export function isExtensionPage(): boolean {
  try {
    return (
      typeof chrome !== 'undefined' &&
      typeof chrome.runtime?.id === 'string' &&
      /^(chrome|moz)-extension:$/.test(globalThis.location?.protocol ?? '')
    );
  } catch {
    return false;
  }
}
