/**
 * Incremental Server-Sent-Events decoder.
 *
 * Feed it *decoded text* chunks exactly as they arrive (chunk boundaries can fall
 * anywhere — in the middle of a line, between "\r" and "\n", inside a JSON payload)
 * and it returns every complete `data` payload.
 *
 * Follows the SSE spec (events end at a blank line, multi-line data is joined with
 * "\n", comments start with ":") and is lenient with servers that forget the blank
 * line between events: if a new `data:` line starts while the pending payload is
 * already complete JSON (or "[DONE]"), the pending payload is dispatched first.
 *
 * Python's version decoded every network chunk on its own, so a multi-byte
 * character split across chunks turned into "���". Decoding is done by the caller
 * with `TextDecoder#decode(chunk, { stream: true })`, which never splits characters.
 */
export class SSEDecoder {
  private buffer = '';
  private dataLines: string[] = [];

  /** Push a chunk of text; returns the data payloads completed by it. */
  push(chunk: string): string[] {
    if (!chunk) return [];
    this.buffer += chunk;
    const out: string[] = [];
    let lineStart = 0;
    const text = this.buffer;
    for (let i = 0; i < text.length; i++) {
      const ch = text.charCodeAt(i);
      if (ch !== 10 /* \n */ && ch !== 13 /* \r */) continue;
      // A trailing "\r" may be the first half of "\r\n" — wait for the next chunk.
      if (ch === 13 && i === text.length - 1) break;
      const line = text.slice(lineStart, i);
      if (ch === 13 && text.charCodeAt(i + 1) === 10) i++;
      lineStart = i + 1;
      this.processLine(line, out);
    }
    this.buffer = text.slice(lineStart);
    return out;
  }

  /** Call once the stream has ended to flush a final event without a trailing blank line. */
  flush(): string[] {
    const out: string[] = [];
    if (this.buffer) {
      const line = this.buffer.replace(/\r$/, '');
      this.buffer = '';
      this.processLine(line, out);
    }
    this.dispatch(out);
    return out;
  }

  private processLine(line: string, out: string[]): void {
    if (line === '') {
      this.dispatch(out);
      return;
    }
    if (line.charCodeAt(0) === 58 /* : */) return; // comment / keep-alive

    const colon = line.indexOf(':');
    const field = colon === -1 ? line : line.slice(0, colon);
    let value = colon === -1 ? '' : line.slice(colon + 1);
    if (value.charCodeAt(0) === 32 /* space */) value = value.slice(1);

    if (field !== 'data') return; // "event", "id", "retry" carry nothing we need

    if (this.dataLines.length > 0 && isCompletePayload(this.dataLines.join('\n'))) {
      this.dispatch(out);
    }
    this.dataLines.push(value);
  }

  private dispatch(out: string[]): void {
    if (this.dataLines.length === 0) return;
    out.push(this.dataLines.join('\n'));
    this.dataLines = [];
  }
}

function isCompletePayload(payload: string): boolean {
  const trimmed = payload.trim();
  if (trimmed === '[DONE]') return true;
  if (!(trimmed.startsWith('{') || trimmed.startsWith('['))) return false;
  try {
    JSON.parse(trimmed);
    return true;
  } catch {
    return false;
  }
}
