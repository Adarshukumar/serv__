// ══════════════════════════════════════════════════════════════
//  thinkSplitter.ts — faithful port of Upstage v3's ThinkSplitter
//
//  Source: New Upstage Change Logs/upstage_provider.py, class ThinkSplitter
//  (_OPEN = "<think>", _CLOSE = "</think>", lines 391-462).
//
//  Upstage inlines reasoning INSIDE content deltas as <think>…</think> markup,
//  and the tags can be split across token boundaries. This holds back a trailing
//  partial tag until the next feed() decides what it was; flush() releases
//  whatever remains when the stream ends.
//
//  Ported line-for-line rather than reimplemented, because the buffer-holdback
//  arithmetic is subtle and already proven in the Python version.
// ══════════════════════════════════════════════════════════════

export const OPEN_TAG = '<think>';
export const CLOSE_TAG = '</think>';

export type SegmentKind = 'content' | 'thinking';
export type Segment = [SegmentKind, string];

export class ThinkSplitter {
  private readonly open: string;
  private readonly close: string;
  private buf = '';
  private inside = false;

  constructor(openTag: string = OPEN_TAG, closeTag: string = CLOSE_TAG) {
    this.open = openTag;
    this.close = closeTag;
  }

  /** Feed raw content tokens; get back clean (kind, segment) pairs. */
  feed(text: string): Segment[] {
    const out: Segment[] = [];
    this.buf += text;

    for (;;) {
      if (this.inside) {
        const j = this.buf.indexOf(this.close);
        if (j === -1) {
          // No close tag yet — hold back the last (len(close)-1) chars in case
          // they are the start of a split "</thi".
          const hold = this.close.length - 1;
          let seg = '';
          if (this.buf.length > hold) {
            seg = this.buf.slice(0, this.buf.length - hold);
            this.buf = this.buf.slice(this.buf.length - hold);
          }
          if (seg) out.push(['thinking', seg]);
          break;
        }
        const seg = this.buf.slice(0, j);
        if (seg) out.push(['thinking', seg]);
        this.inside = false;
        this.buf = this.buf.slice(j + this.close.length);
      } else {
        const i = this.buf.indexOf(this.open);
        if (i === -1) {
          const hold = this.open.length - 1;
          let seg = '';
          if (this.buf.length > hold) {
            seg = this.buf.slice(0, this.buf.length - hold);
            this.buf = this.buf.slice(this.buf.length - hold);
          }
          if (seg) out.push(['content', seg]);
          break;
        }
        const seg = this.buf.slice(0, i);
        if (seg) out.push(['content', seg]);
        this.inside = true;
        this.buf = this.buf.slice(i + this.open.length);
      }
    }
    return out;
  }

  /** Release anything still buffered (stream over). */
  flush(): Segment[] {
    if (!this.buf) return [];
    const kind: SegmentKind = this.inside ? 'thinking' : 'content';
    const seg = this.buf;
    this.buf = '';
    return [[kind, seg]];
  }

  /** True while sitting inside an unclosed <think> region. */
  get inThinking(): boolean {
    return this.inside;
  }

  reset(): void {
    this.buf = '';
    this.inside = false;
  }
}
