// ══════════════════════════════════════════════════════════════
//  sse.ts — Server-Sent-Events line framing
//
//  All seven providers stream SSE, but they disagree on the details, and every
//  difference below was lifted from the Python parsers rather than assumed:
//
//   · DeepInfra/mCloudFlare/Dolphin/LLMChat/Mercury match `line.startswith("data:")`
//     and slice 5 chars; Upstage v3 matches `"data: "` (with a space) and slices 6.
//     Both then `.strip()`, so a single trim-after-colon rule satisfies all of them.
//   · Mercury additionally skips comment lines (`:`), `event:` and `id:` fields.
//   · `[DONE]` terminates DeepInfra, mCloudFlare, Dolphin, LLMChat, Mercury.
//     Upstage v3 also terminates on `choices[0].finish_reason === "stop"`, and
//     emits `usage` on the SAME line before the done marker — so a framer that
//     short-circuits on done would drop the usage. Ordering is preserved here.
//   · mCloudFlare buffers `iter_content()` and splits on "\n" manually, so chunks
//     can arrive split mid-line. Same for every fetch-based reader.
// ══════════════════════════════════════════════════════════════

export type SSEFrame =
  | { type: 'data'; payload: string }
  | { type: 'done' };

export const DONE_SENTINEL = '[DONE]';

/**
 * Incremental SSE framer. Feed it raw text chunks of any size; it hands back
 * complete frames and retains any partial trailing line.
 */
export class SSEFramer {
  private buf = '';
  private sawDone = false;

  push(chunk: string): SSEFrame[] {
    this.buf += chunk;
    const out: SSEFrame[] = [];

    for (;;) {
      const nl = this.buf.indexOf('\n');
      if (nl === -1) break;
      const rawLine = this.buf.slice(0, nl);
      this.buf = this.buf.slice(nl + 1);
      const frame = this.readLine(rawLine);
      if (frame) {
        out.push(frame);
        if (frame.type === 'done') {
          this.sawDone = true;
          break;
        }
      }
    }
    return out;
  }

  /** Release a final unterminated line, if the stream ended without a newline. */
  end(): SSEFrame[] {
    const out: SSEFrame[] = [];
    if (this.buf.trim()) {
      const frame = this.readLine(this.buf);
      this.buf = '';
      if (frame) out.push(frame);
    }
    return out;
  }

  get done(): boolean {
    return this.sawDone;
  }

  reset(): void {
    this.buf = '';
    this.sawDone = false;
  }

  private readLine(rawLine: string): SSEFrame | null {
    const line = rawLine.replace(/\r$/, '').trim();
    if (!line) return null;

    // Mercury's parser ignores comment lines and non-data SSE fields.
    if (line.startsWith(':')) return null;
    if (line.startsWith('event:') || line.startsWith('id:') || line.startsWith('retry:')) {
      return null;
    }
    if (!line.startsWith('data:')) return null;

    // Covers both `data:X` and `data: X` — the Python code strips afterwards too.
    const payload = line.slice(5).trim();
    if (!payload) return null;
    if (payload === DONE_SENTINEL) return { type: 'done' };
    return { type: 'data', payload };
  }
}

/** Parse one SSE data payload as JSON, returning undefined when it is not JSON. */
export function parseData(payload: string): unknown {
  try {
    return JSON.parse(payload);
  } catch {
    return undefined;
  }
}

/** Encode an event for the bridge→browser SSE leg. */
export function encodeSSE(event: string, data: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}
