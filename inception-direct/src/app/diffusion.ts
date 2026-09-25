/**
 * Diffusion view helpers.
 *
 * In diffusing mode the API streams the *whole* text at every denoising step. A
 * diffusion model refines a fixed canvas in place, so comparing two steps word by
 * word *at the same position* shows exactly which words the model just settled —
 * that's what gets highlighted. Linear time, cheap enough for every frame.
 */

export interface CanvasSegment {
  text: string;
  /** Changed since the previous frame. */
  fresh: boolean;
}

export function diffCanvas(previous: string, next: string): CanvasSegment[] {
  if (!next) return [];
  if (!previous) return [{ text: next, fresh: true }];
  const before = previous.split(/(\s+)/);
  const after = next.split(/(\s+)/);
  const out: CanvasSegment[] = [];
  let run = '';
  let runFresh = false;
  for (let i = 0; i < after.length; i++) {
    const token = after[i]!;
    if (!token) continue;
    // Whitespace joins whatever run it sits in, so segments stay few and long.
    const fresh: boolean = /\S/.test(token) ? token !== before[i] : runFresh;
    if (fresh !== runFresh && run) {
      out.push({ text: run, fresh: runFresh });
      run = '';
    }
    runFresh = fresh;
    run += token;
  }
  if (run) out.push({ text: run, fresh: runFresh });
  return out;
}

/** Share of words that changed between two steps (0–1), for the step meter. */
export function changedShare(previous: string, next: string): number {
  const segments = diffCanvas(previous, next);
  let fresh = 0;
  let total = 0;
  for (const s of segments) {
    const words = s.text.split(/\s+/).filter(Boolean).length;
    total += words;
    if (s.fresh) fresh += words;
  }
  return total ? fresh / total : 0;
}
