import DOMPurify from 'dompurify';
import hljs from 'highlight.js/lib/common';
import { Marked, type Tokens } from 'marked';
import { escapeHtml, mathExtension } from './math';

/**
 * Markdown → safe, typeset HTML.
 *
 * - GFM (tables, task lists, strikethrough), TeX math via KaTeX, highlighted code.
 * - Everything is sanitised with DOMPurify: model output is untrusted, and this runs
 *   on an extension page.
 * - Remote images become links: rendering them would make the browser contact
 *   arbitrary servers, which this app promises not to do.
 */

const highlightCache = new Map<string, string>();
const HIGHLIGHT_CACHE_LIMIT = 300;

function highlight(code: string, language: string): string {
  const key = `${language}\u0000${code}`;
  const cached = highlightCache.get(key);
  if (cached !== undefined) return cached;
  let html: string;
  try {
    html = language && hljs.getLanguage(language)
      ? hljs.highlight(code, { language, ignoreIllegals: true }).value
      : escapeHtml(code);
  } catch {
    html = escapeHtml(code);
  }
  if (highlightCache.size >= HIGHLIGHT_CACHE_LIMIT) {
    const oldest = highlightCache.keys().next().value;
    if (oldest !== undefined) highlightCache.delete(oldest);
  }
  highlightCache.set(key, html);
  return html;
}

const LANGUAGE_ALIASES: Record<string, string> = {
  js: 'javascript',
  ts: 'typescript',
  py: 'python',
  sh: 'bash',
  shell: 'bash',
  zsh: 'bash',
  yml: 'yaml',
  md: 'markdown',
  'c++': 'cpp',
  'c#': 'csharp',
  rs: 'rust',
  kt: 'kotlin',
  html: 'xml',
  htm: 'xml',
  svg: 'xml',
};

function languageOf(info: string | undefined): { id: string; label: string } {
  const raw = (info ?? '').trim().split(/\s+/)[0]?.toLowerCase() ?? '';
  const id = LANGUAGE_ALIASES[raw] ?? raw;
  return { id, label: raw || 'text' };
}

const marked = new Marked({ gfm: true, breaks: false });
marked.use(mathExtension());
marked.use({
  renderer: {
    code({ text, lang }: Tokens.Code) {
      const { id, label } = languageOf(lang);
      const body = highlight(text.replace(/\n$/, ''), id);
      return (
        `<figure class="code-block">` +
        `<figcaption><span class="code-lang">${escapeHtml(label)}</span>` +
        `<button type="button" class="code-copy" data-copy-code>Copy</button></figcaption>` +
        `<pre><code class="hljs${id ? ` language-${escapeHtml(id)}` : ''}">${body}</code></pre>` +
        `</figure>\n`
      );
    },
    image({ href, text }: Tokens.Image) {
      const label = text?.trim() || 'image';
      return `<a class="image-link" href="${escapeHtml(href)}">Image: ${escapeHtml(label)}</a>`;
    },
  },
});

let hooksInstalled = false;
function installHooks(): void {
  if (hooksInstalled) return;
  hooksInstalled = true;
  DOMPurify.addHook('afterSanitizeAttributes', (node) => {
    if (node.tagName === 'A') {
      node.setAttribute('target', '_blank');
      node.setAttribute('rel', 'noopener noreferrer');
    }
    if (node.tagName === 'INPUT') node.setAttribute('disabled', '');
  });
}

const PURIFY_OPTIONS = {
  ADD_ATTR: ['target', 'data-copy-code'],
  FORBID_TAGS: ['style', 'img', 'video', 'audio', 'iframe', 'object', 'embed', 'form', 'link', 'meta'],
  FORBID_ATTR: ['srcset', 'ping', 'formaction'],
};

export function renderMarkdown(source: string): string {
  if (!source) return '';
  // Never emit unsanitised HTML: without a working sanitizer, show the text as-is.
  if (!DOMPurify.isSupported) return `<p>${escapeHtml(source).replace(/\n/g, '<br>')}</p>`;
  installHooks();
  const html = marked.parse(source, { async: false });
  return DOMPurify.sanitize(html, PURIFY_OPTIONS);
}

/** Plain-text word count for the metadata line. */
export function countWords(source: string): number {
  const matches = source.replace(/```[\s\S]*?```/g, ' ').match(/[\p{L}\p{N}][\p{L}\p{M}\p{N}'’-]*/gu);
  return matches ? matches.length : 0;
}
