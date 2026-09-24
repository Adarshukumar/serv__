import katex from 'katex';
import type { MarkedExtension, Tokens } from 'marked';

/**
 * TeX math for marked: $$…$$ and \[…\] (display), \(…\) and $…$ (inline).
 *
 * Inline `$…$` is deliberately strict so prices don't turn into math:
 * no space right after the opening $, none right before the closing $,
 * no digit right after the closing $, and not a bare number ("$5 and $10" stays text).
 */

const BLOCK_DOLLARS = /^\$\$([\s\S]+?)\$\$[ \t]*(?:\n+|$)/;
const BLOCK_BRACKETS = /^\\\[([\s\S]+?)\\\][ \t]*(?:\n+|$)/;
const INLINE_PARENS = /^\\\(([\s\S]+?)\\\)/;
const INLINE_DISPLAY = /^\$\$([^\n]+?)\$\$/;
const INLINE_DOLLAR = /^\$(?![\s$])((?:\\\$|[^$\n])+?)(?<![\s\\])\$(?!\d)/;

interface MathToken extends Tokens.Generic {
  text: string;
  display: boolean;
}

export function renderTex(tex: string, display: boolean): string {
  try {
    return katex.renderToString(tex, {
      displayMode: display,
      throwOnError: false,
      strict: 'ignore',
      output: 'htmlAndMathml',
      trust: false,
    });
  } catch {
    return `<code class="math-fallback">${escapeHtml(tex)}</code>`;
  }
}

export function mathExtension(): MarkedExtension {
  return {
    extensions: [
      {
        name: 'mathBlock',
        level: 'block',
        start(src: string) {
          const index = src.search(/\$\$|\\\[/);
          return index < 0 ? undefined : index;
        },
        tokenizer(src: string): MathToken | undefined {
          const match = BLOCK_DOLLARS.exec(src) ?? BLOCK_BRACKETS.exec(src);
          if (!match) return undefined;
          return { type: 'mathBlock', raw: match[0], text: match[1]!.trim(), display: true };
        },
        renderer(token) {
          return `<div class="math-block">${renderTex((token as MathToken).text, true)}</div>\n`;
        },
      },
      {
        name: 'mathInline',
        level: 'inline',
        start(src: string) {
          const index = src.search(/\$|\\\(/);
          return index < 0 ? undefined : index;
        },
        tokenizer(src: string): MathToken | undefined {
          let match = INLINE_PARENS.exec(src);
          if (match) return { type: 'mathInline', raw: match[0], text: match[1]!.trim(), display: false };
          match = INLINE_DISPLAY.exec(src);
          if (match) return { type: 'mathInline', raw: match[0], text: match[1]!.trim(), display: true };
          match = INLINE_DOLLAR.exec(src);
          if (match && !/^[\d.,\s]+$/.test(match[1]!)) {
            return { type: 'mathInline', raw: match[0], text: match[1]!, display: false };
          }
          return undefined;
        },
        renderer(token) {
          const t = token as MathToken;
          return renderTex(t.text, t.display);
        },
      },
    ],
  };
}

export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
