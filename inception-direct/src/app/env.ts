import { normaliseApiUrl } from '../core/config';

/**
 * Where Inception's API lives. Overridable at build time (VITE_INCEPTION_API_URL) so
 * the test-suite can point a build at a local simulator; real builds use
 * https://api.inceptionlabs.ai.
 */
export const API_URL = normaliseApiUrl(import.meta.env.VITE_INCEPTION_API_URL as string | undefined);
export const API_HOST = new URL(API_URL).host;
