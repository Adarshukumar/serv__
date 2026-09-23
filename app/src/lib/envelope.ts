// ══════════════════════════════════════════════════════════════
//  src/lib/envelope.ts — parser for the bridge→browser SSE envelope
//
//  Two SSE layers exist and must not be confused:
//
//    OUTER  bridge → browser. Uses `event:` + `data:` fields to carry control
//           frames (meta / raw / error / end). Parsed HERE.
//    INNER  provider → bridge, relayed verbatim inside `raw` frames. Uses only
//           `data:` lines in one of four provider wire formats. Parsed by
//           SSEFramer + a normaliser.
//
//  EventSource cannot be used for the outer layer because the request is a POST
//  with a JSON body, so this reads a fetch ReadableStream instead.
// ══════════════════════════════════════════════════════════════

export type EnvelopeEvent =
  | { event: 'meta'; data: { provider: string; wire: string; model?: string; url?: string } }
  | { event: 'raw'; data: { chunk: string } }
  | { event: 'error'; data: { message: string; retryable: boolean; code?: string } }
  | { event: 'end'; data: Record<string, unknown> }
  | { event: string; data: unknown };

/**
 * Incremental parser for the outer envelope. SSE events are separated by a blank
 * line; `data:` may repeat within one event and must be joined with "\n".
 */
export class EnvelopeParser {
  private buf = '';

  push(chunk: string): EnvelopeEvent[] {
    this.buf += chunk;
    const out: EnvelopeEvent[] = [];

    for (;;) {
      // Accept both \n\n and \r\n\r\n as the event separator.
      const idx = this.findBoundary();
      if (idx === null) break;
      const block = this.buf.slice(0, idx.start);
      this.buf = this.buf.slice(idx.end);
      const ev = this.parseBlock(block);
      if (ev) out.push(ev);
    }
    return out;
  }

  end(): EnvelopeEvent[] {
    const rest = this.buf.trim();
    this.buf = '';
    if (!rest) return [];
    const ev = this.parseBlock(rest);
    return ev ? [ev] : [];
  }

  private findBoundary(): { start: number; end: number } | null {
    const a = this.buf.indexOf('\n\n');
    const b = this.buf.indexOf('\r\n\r\n');
    if (a === -1 && b === -1) return null;
    if (b === -1 || (a !== -1 && a < b)) return { start: a, end: a + 2 };
    return { start: b, end: b + 4 };
  }

  private parseBlock(block: string): EnvelopeEvent | null {
    let event = 'message';
    const dataLines: string[] = [];

    for (const rawLine of block.split(/\r?\n/)) {
      const line = rawLine.trimEnd();
      if (!line || line.startsWith(':')) continue;
      const colon = line.indexOf(':');
      const field = colon === -1 ? line : line.slice(0, colon);
      let value = colon === -1 ? '' : line.slice(colon + 1);
      if (value.startsWith(' ')) value = value.slice(1);
      if (field === 'event') event = value;
      else if (field === 'data') dataLines.push(value);
    }

    if (!dataLines.length) return null;
    const joined = dataLines.join('\n');
    try {
      return { event, data: JSON.parse(joined) } as EnvelopeEvent;
    } catch {
      return { event, data: joined } as EnvelopeEvent;
    }
  }
}
