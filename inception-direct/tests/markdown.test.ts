// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { countWords, renderMarkdown } from '../src/app/markdown/render';

function dom(html: string): HTMLElement {
  const div = document.createElement('div');
  div.innerHTML = html;
  return div;
}

describe('renderMarkdown', () => {
  it('typesets common markdown', () => {
    const el = dom(renderMarkdown('## Title\n\nSome *emphasis* and **strength**.\n\n- one\n- two\n\n| a | b |\n|---|---|\n| 1 | 2 |'));
    expect(el.querySelector('h2')?.textContent).toBe('Title');
    expect(el.querySelector('em')?.textContent).toBe('emphasis');
    expect(el.querySelectorAll('li')).toHaveLength(2);
    expect(el.querySelector('table td')?.textContent).toBe('1');
  });

  it('highlights fenced code and adds a copy button', () => {
    const el = dom(renderMarkdown('```py\ndef f():\n    return 1\n```'));
    const figure = el.querySelector('figure.code-block')!;
    expect(figure.querySelector('.code-lang')?.textContent).toBe('py');
    expect(figure.querySelector('[data-copy-code]')).not.toBeNull();
    expect(figure.querySelector('code.language-python .hljs-keyword')?.textContent).toBe('def');
    expect(figure.querySelector('code')?.textContent).toBe('def f():\n    return 1');
  });

  it('renders TeX math but leaves prices alone', () => {
    const el = dom(renderMarkdown('Euler: $e^{i\\pi}+1=0$ and \\(a^2\\). Costs $5 and $10.\n\n$$\\int_0^1 x\\,dx$$'));
    expect(el.querySelectorAll('.katex').length).toBe(3);
    expect(el.querySelector('.math-block .katex-display')).not.toBeNull();
    expect(el.textContent).toContain('Costs $5 and $10.');
  });

  it('keeps partial math as text while streaming', () => {
    const el = dom(renderMarkdown('Here comes $$\\frac{a'));
    expect(el.querySelector('.katex')).toBeNull();
    expect(el.textContent).toContain('$$\\frac{a');
  });

  it('sanitises dangerous HTML from model output', () => {
    const html = renderMarkdown(
      'Hi <script>alert(1)</script><img src=x onerror="alert(2)"><iframe src="https://evil.example"></iframe>' +
        '<a href="javascript:alert(3)">click</a> <b onclick="x()">bold</b>',
    );
    const el = dom(html);
    expect(el.querySelector('script, img, iframe')).toBeNull();
    expect(html).not.toMatch(/onerror|onclick|javascript:/i);
    expect(el.querySelector('b')?.textContent).toBe('bold');
  });

  it('turns images into links instead of loading them (no third-party requests)', () => {
    const el = dom(renderMarkdown('![a chart](https://tracker.example/pixel.png)'));
    expect(el.querySelector('img')).toBeNull();
    const link = el.querySelector('a.image-link')!;
    expect(link.getAttribute('href')).toBe('https://tracker.example/pixel.png');
    expect(link.textContent).toBe('Image: a chart');
  });

  it('opens links in a new tab without leaking the opener', () => {
    const link = dom(renderMarkdown('[docs](https://docs.inceptionlabs.ai)')).querySelector('a')!;
    expect(link.getAttribute('target')).toBe('_blank');
    expect(link.getAttribute('rel')).toBe('noopener noreferrer');
  });

  it('handles an unterminated code fence mid-stream', () => {
    const el = dom(renderMarkdown('Look:\n\n```js\nconst a = 1;'));
    expect(el.querySelector('code')?.textContent).toContain('const a = 1;');
  });
});

describe('countWords', () => {
  it('counts words across scripts and ignores code blocks', () => {
    expect(countWords('Hello there, world')).toBe(3);
    expect(countWords('नमस्ते दुनिया')).toBe(2);
    expect(countWords('one\n```\nlots of code here\n```\ntwo')).toBe(2);
  });
});
