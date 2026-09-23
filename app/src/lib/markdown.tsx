// ══════════════════════════════════════════════════════════════
//  src/lib/markdown.tsx — minimal dependency-free markdown renderer
//
//  Deliberately small: fenced code, headings, lists, blockquotes, rules,
//  paragraphs, and inline bold / italic / code / links. Streaming-safe — a
//  partial fence or a half-written inline span renders as plain text rather
//  than throwing or flickering.
//
//  Links are restricted to http(s) so a `javascript:` URL in model output can
//  never become clickable. That is the one piece of hardening kept in scope.
// ══════════════════════════════════════════════════════════════
import type { ReactNode } from 'react';

const INLINE = /(\*\*\*[^*]+\*\*\*|\*\*[^*]+\*\*|\*[^*\n]+\*|`[^`]+`|\[[^\]]+\]\([^)\s]+\))/g;

function safeHref(href: string): string | null {
  try {
    const u = new URL(href);
    return u.protocol === 'http:' || u.protocol === 'https:' ? u.toString() : null;
  } catch {
    return null;
  }
}

function inline(text: string, keyBase: string): ReactNode[] {
  const out: ReactNode[] = [];
  let last = 0;
  let i = 0;
  for (const m of text.matchAll(INLINE)) {
    const idx = m.index ?? 0;
    if (idx > last) out.push(text.slice(last, idx));
    const tok = m[0];
    const k = `${keyBase}-i${i++}`;
    if (tok.startsWith('***')) out.push(<strong key={k}><em>{tok.slice(3, -3)}</em></strong>);
    else if (tok.startsWith('**')) out.push(<strong key={k}>{tok.slice(2, -2)}</strong>);
    else if (tok.startsWith('`')) out.push(<code key={k}>{tok.slice(1, -1)}</code>);
    else if (tok.startsWith('[')) {
      const close = tok.indexOf('](');
      const label = tok.slice(1, close);
      const href = safeHref(tok.slice(close + 2, -1));
      out.push(
        href ? (
          <a key={k} href={href} target="_blank" rel="noreferrer noopener">{label}</a>
        ) : (
          <span key={k}>{label}</span>
        ),
      );
    } else out.push(<em key={k}>{tok.slice(1, -1)}</em>);
    last = idx + tok.length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

export function Markdown({ text, streaming = false }: { text: string; streaming?: boolean }): ReactNode {
  const blocks: ReactNode[] = [];
  const lines = text.split('\n');
  let i = 0;
  let key = 0;

  while (i < lines.length) {
    const line = lines[i];

    // ── fenced code ──
    if (line.trimStart().startsWith('```')) {
      const lang = line.trim().slice(3).trim();
      const body: string[] = [];
      i++;
      let closed = false;
      while (i < lines.length) {
        if (lines[i].trimStart().startsWith('```')) {
          closed = true;
          i++;
          break;
        }
        body.push(lines[i++]);
      }
      blocks.push(
        <pre key={`b${key++}`}>
          {lang ? <span className="lang" /> : null}
          <code>{body.join('\n')}</code>
        </pre>,
      );
      // An unclosed fence while streaming is normal; just keep rendering.
      if (!closed && !streaming) break;
      continue;
    }

    // ── horizontal rule ──
    if (/^\s*(-{3,}|\*{3,}|_{3,})\s*$/.test(line)) {
      blocks.push(<hr key={`b${key++}`} />);
      i++;
      continue;
    }

    // ── heading ──
    const h = /^(#{1,3})\s+(.*)$/.exec(line);
    if (h) {
      const level = h[1].length;
      const content = inline(h[2], `b${key}`);
      blocks.push(
        level === 1 ? <h1 key={`b${key++}`}>{content}</h1>
        : level === 2 ? <h2 key={`b${key++}`}>{content}</h2>
        : <h3 key={`b${key++}`}>{content}</h3>,
      );
      i++;
      continue;
    }

    // ── blockquote ──
    if (/^\s*>\s?/.test(line)) {
      const quote: string[] = [];
      while (i < lines.length && /^\s*>\s?/.test(lines[i])) quote.push(lines[i].replace(/^\s*>\s?/, '')), i++;
      blocks.push(<blockquote key={`b${key++}`}>{inline(quote.join('\n'), `b${key}`)}</blockquote>);
      continue;
    }

    // ── unordered list ──
    if (/^\s*[-*+]\s+/.test(line)) {
      const items: string[] = [];
      while (i < lines.length && /^\s*[-*+]\s+/.test(lines[i])) items.push(lines[i].replace(/^\s*[-*+]\s+/, '')), i++;
      blocks.push(
        <ul key={`b${key++}`}>
          {items.map((it, n) => <li key={n}>{inline(it, `b${key}-${n}`)}</li>)}
        </ul>,
      );
      continue;
    }

    // ── ordered list ──
    if (/^\s*\d+[.)]\s+/.test(line)) {
      const items: string[] = [];
      while (i < lines.length && /^\s*\d+[.)]\s+/.test(lines[i])) items.push(lines[i].replace(/^\s*\d+[.)]\s+/, '')), i++;
      blocks.push(
        <ol key={`b${key++}`}>
          {items.map((it, n) => <li key={n}>{inline(it, `b${key}-${n}`)}</li>)}
        </ol>,
      );
      continue;
    }

    // ── blank ──
    if (!line.trim()) {
      i++;
      continue;
    }

    // ── paragraph: gather until a blank line or a new block start ──
    const para: string[] = [];
    while (
      i < lines.length &&
      lines[i].trim() &&
      !lines[i].trimStart().startsWith('```') &&
      !/^(#{1,3})\s+/.test(lines[i]) &&
      !/^\s*[-*+]\s+/.test(lines[i]) &&
      !/^\s*\d+[.)]\s+/.test(lines[i]) &&
      !/^\s*>\s?/.test(lines[i])
    ) {
      para.push(lines[i++]);
    }
    if (para.length) blocks.push(<p key={`b${key++}`}>{inline(para.join('\n'), `b${key}`)}</p>);
    else i++; // safety: never loop forever on an unclassified line
  }

  return <>{blocks}</>;
}
