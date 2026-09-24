import { useEffect, useMemo, useRef } from 'react'
import { marked } from 'marked'
import DOMPurify from 'dompurify'

marked.setOptions({ gfm: true, breaks: true })

// Links always open in a new tab, safely.
DOMPurify.addHook('afterSanitizeAttributes', (node) => {
  if (node.tagName === 'A') {
    node.setAttribute('target', '_blank')
    node.setAttribute('rel', 'noopener noreferrer')
  }
})

/**
 * Markdown renderer with:
 *   • sanitisation (DOMPurify) — model output is untrusted input
 *   • per-code-block copy buttons, injected after render
 *   • language badge on fenced blocks
 *   • a streaming caret while tokens are still arriving
 */
export default function Markdown({ text, streaming = false }) {
  const ref = useRef(null)

  const html = useMemo(() => {
    const raw = marked.parse(text || '', { async: false })
    return DOMPurify.sanitize(raw, { ADD_ATTR: ['target', 'rel'] })
  }, [text])

  useEffect(() => {
    const root = ref.current
    if (!root) return
    root.querySelectorAll('pre').forEach((pre) => {
      if (pre.dataset.enhanced) return
      pre.dataset.enhanced = '1'

      const code = pre.querySelector('code')
      const langMatch = code?.className?.match(/language-([\w+#-]+)/i)
      const bar = document.createElement('div')
      bar.className = 'code-bar'
      bar.innerHTML = `<span class="code-lang">${langMatch ? langMatch[1] : 'code'}</span>`

      const btn = document.createElement('button')
      btn.type = 'button'
      btn.className = 'code-copy'
      btn.textContent = 'copy'
      btn.addEventListener('click', async () => {
        try {
          await navigator.clipboard.writeText(code?.innerText ?? pre.innerText)
          btn.textContent = 'copied ✓'
          btn.classList.add('is-copied')
          setTimeout(() => {
            btn.textContent = 'copy'
            btn.classList.remove('is-copied')
          }, 1400)
        } catch {
          btn.textContent = 'ctrl+c'
        }
      })

      bar.appendChild(btn)
      pre.prepend(bar)
    })
  }, [html])

  return (
    <div className="markdown-wrap">
      <div ref={ref} className="markdown" dangerouslySetInnerHTML={{ __html: html }} />
      {streaming && <span className="caret" aria-hidden />}
    </div>
  )
}
