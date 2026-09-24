import { memo, useCallback, useLayoutEffect, useMemo, useRef, type MouseEvent } from 'react';
import { renderMarkdown } from '../markdown/render';

interface MarkdownProps {
  text: string;
  streaming?: boolean;
  className?: string;
}

/** Renders sanitised markdown; while streaming, a caret sits after the last word. */
export const Markdown = memo(function Markdown({ text, streaming = false, className }: MarkdownProps) {
  const ref = useRef<HTMLDivElement>(null);
  const html = useMemo(() => renderMarkdown(text), [text]);

  useLayoutEffect(() => {
    placeCaret(ref.current, streaming);
  }, [html, streaming]);

  const onClick = useCallback((event: MouseEvent<HTMLDivElement>) => {
    const button = (event.target as HTMLElement).closest<HTMLButtonElement>('[data-copy-code]');
    if (!button) return;
    const code = button.closest('figure')?.querySelector('code')?.textContent ?? '';
    void navigator.clipboard?.writeText(code).then(
      () => {
        button.textContent = 'Copied';
        window.setTimeout(() => {
          button.textContent = 'Copy';
        }, 1400);
      },
      () => {
        button.textContent = 'Copy failed';
      },
    );
  }, []);

  return <div ref={ref} className={className} onClick={onClick} dangerouslySetInnerHTML={{ __html: html }} />;
});

const STOP_AT = new Set(['BUTTON', 'FIGCAPTION', 'svg', 'math']);

function placeCaret(root: HTMLElement | null, on: boolean): void {
  if (!root) return;
  for (const old of root.querySelectorAll('.caret')) old.remove();
  if (!on) return;

  const caret = document.createElement('span');
  caret.className = 'caret';
  caret.setAttribute('aria-hidden', 'true');

  let node: Node | null = root.lastChild;
  while (node) {
    if (node.nodeType === Node.TEXT_NODE) {
      if (node.textContent?.trim()) break;
      node = node.previousSibling;
      continue;
    }
    if (node instanceof Element) {
      const atomic = node.classList.contains('katex') || node.classList.contains('katex-display') || STOP_AT.has(node.tagName);
      if (atomic || !node.lastChild) break;
      node = node.lastChild;
      continue;
    }
    node = node.previousSibling;
  }

  if (!node || !node.parentNode) {
    root.appendChild(caret);
  } else if (node.nodeType === Node.TEXT_NODE || (node instanceof Element && (node.classList.contains('katex') || node.classList.contains('katex-display')))) {
    node.parentNode.insertBefore(caret, node.nextSibling);
  } else if (node instanceof Element && !STOP_AT.has(node.tagName)) {
    node.appendChild(caret);
  } else {
    node.parentNode.insertBefore(caret, node.nextSibling);
  }
}
