// The resume renders in an iframe (its own print CSS). These helpers work on that document.

/** Editor-only styles injected into the preview frame. */
export const FRAME_STYLE = `
  html { background: transparent !important; }
  body { margin: 0 auto !important; box-shadow: 0 1px 3px rgba(0,0,0,.12), 0 12px 40px rgba(0,0,0,.18); position: relative;
    /* Page-break guides, so the page limit is visible while editing. */
    background-image: repeating-linear-gradient(to bottom, transparent 0, transparent calc(var(--page-h) - 1px), rgba(220,60,60,.5) calc(var(--page-h) - 1px), rgba(220,60,60,.5) var(--page-h)) !important; }
  [data-id] { outline: 1px solid transparent; outline-offset: 3px; border-radius: 3px; transition: outline-color .15s, background .3s; cursor: text; }
  [data-id]:not([data-edit]) { cursor: pointer; }
  [data-id]:hover { outline-color: rgba(100,120,200,.35); }
  [data-id]:focus { outline-color: rgba(100,120,200,.8); }
  .sd-selected { outline-color: rgba(100,120,200,.9) !important; }
  .sd-pending { background: rgba(77,127,224,.13); box-shadow: -10px 0 0 -7px rgba(77,127,224,.9); }
  .sd-note { box-shadow: 12px 0 0 -9px #d9a520; }
  .sd-spot { background: rgba(217,165,32,.22) !important; outline-color: rgba(217,165,32,.8) !important; }
  .sd-match-strong { box-shadow: -14px 0 0 -11px rgb(60,160,100); }
  .sd-match-partial { box-shadow: -14px 0 0 -11px rgb(80,130,220); }
  .sd-match-weak { box-shadow: -14px 0 0 -11px rgb(220,120,50); }
  @keyframes sdflash { from { background: rgba(77,127,224,.3); } to { background: transparent; } }
  .sd-flash { animation: sdflash 2s ease-out; }
`

export const byId = (doc: Document | null | undefined, id: string | null | undefined) =>
  doc && id ? doc.querySelector<HTMLElement>(`[data-id="${CSS.escape(id)}"]`) : null

/** Inner HTML of a line as the user edited it, without editor attributes. */
export const lineHtml = (el: HTMLElement) => {
  const c = el.cloneNode(true) as HTMLElement
  c.querySelectorAll('[contenteditable],[spellcheck]').forEach((n) => {
    n.removeAttribute('contenteditable')
    n.removeAttribute('spellcheck')
  })
  // Collapse whitespace but don't trim: this runs on every keystroke, and a trailing space is the
  // one the user just typed. The renderer ignores edge whitespace.
  return c.innerHTML.replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ')
}
