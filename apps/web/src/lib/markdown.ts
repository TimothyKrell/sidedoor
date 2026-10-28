import DOMPurify from 'dompurify'
import { marked } from 'marked'

marked.setOptions({ gfm: true, breaks: false })

/**
 * Markdown to safe HTML. Agent output, packages and documents can contain text from job postings
 * and web pages, so everything rendered is sanitized: no scripts, handlers, iframes or styles, no
 * remote images (a posting could use one to see when you read it), and links only to http(s),
 * mailto and app paths.
 */
export const renderMarkdown = (md: string | null | undefined) => {
  const raw = marked.parse(md ?? '', { async: false })
  const clean = DOMPurify.sanitize(raw, {
    USE_PROFILES: { html: true },
    FORBID_TAGS: ['style', 'iframe', 'form', 'input', 'button', 'textarea', 'select', 'object', 'embed', 'img', 'picture', 'source', 'video', 'audio'],
    FORBID_ATTR: ['style'],
    ALLOWED_URI_REGEXP: /^(?:https?:|mailto:|\/(?!\/))/i,
  })
  // Open external links in a new window; app paths are handled by the click handler.
  return clean.replace(/<a href="(https?:[^"]+)"/g, '<a target="_blank" rel="noreferrer" href="$1"')
}
