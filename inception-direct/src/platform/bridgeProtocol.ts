/**
 * Messages between the app page and the content script that runs inside a
 * chat.inceptionlabs.ai tab. Everything is JSON-serialisable (Port messages are).
 */
export const BRIDGE_PORT_NAME = 'inception-direct:bridge';
export const PROBE_MESSAGE = 'inception-direct:probe';

export type BridgeRequest =
  | {
      t: 'req';
      id: string;
      url: string;
      method: string;
      headers: [string, string][];
      body?: string;
    }
  | { t: 'abort'; id: string };

export type BridgeReply =
  | { t: 'head'; id: string; status: number; statusText: string; headers: [string, string][] }
  /** Body text, already UTF-8 decoded in streaming mode by the content script. */
  | { t: 'chunk'; id: string; data: string }
  | { t: 'end'; id: string }
  | { t: 'fail'; id: string; message: string; aborted?: boolean };

export interface ProbeMessage {
  t: typeof PROBE_MESSAGE;
}

export interface ProbeResult {
  /** The tab shows the real site and its /api/session answers with a token. */
  ready: boolean;
  /** "checkpoint", "session 429", "network", "ok", … */
  reason: string;
  title?: string;
  url?: string;
}
