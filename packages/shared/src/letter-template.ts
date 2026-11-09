// Cover letter templates. Plain text is the user's own and is kept exactly. [square brackets] hold
// an instruction: the AI writes that part. {curly braces} hold the user's words, which the AI may
// adapt a little to fit the job. A backslash keeps a bracket literal: \[ \] \{ \}.

export type TemplatePart = { kind: 'text'; text: string } | { kind: 'write' | 'adapt'; n: number; text: string }

const CLOSE = { '[': ']', '{': '}' } as const

export function parseTemplate(body: string): TemplatePart[] {
  const parts: TemplatePart[] = []
  let text = ''
  let n = 0
  let i = 0
  while (i < body.length) {
    const c = body[i]!
    if (c === '\\' && /[[\]{}]/.test(body[i + 1] ?? '')) {
      text += body[i + 1]
      i += 2
      continue
    }
    if (c === '[' || c === '{') {
      // A slot runs to its matching close; brackets inside it nest (an adapt can hold a [hint]).
      let depth = 0
      let j = i
      for (; j < body.length; j++) {
        const d = body[j]
        if (d === '\\') j++
        else if (d === c) depth++
        else if (d === CLOSE[c] && --depth === 0) break
      }
      const inner = j < body.length ? body.slice(i + 1, j).trim() : ''
      if (inner) {
        if (text) parts.push({ kind: 'text', text })
        text = ''
        parts.push({ kind: c === '[' ? 'write' : 'adapt', n: ++n, text: inner })
        i = j + 1
        continue
      }
    }
    text += c
    i++
  }
  if (text) parts.push({ kind: 'text', text })
  return parts
}

/** Put the AI's text in the slots. A missing adapt keeps the user's words; a missing write is an error. */
export function fillTemplate(parts: TemplatePart[], fills: Map<number, string>) {
  const missing: number[] = []
  const out = parts
    .map((p) => {
      if (p.kind === 'text') return p.text
      const f = fills.get(p.n)?.trim()
      if (f) return f
      if (p.kind === 'write') missing.push(p.n)
      return p.text
    })
    .join('')
  return { text: out.replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim(), missing }
}

/** The template as the AI sees it: each slot numbered, so it can answer slot by slot. */
export const markedTemplate = (parts: TemplatePart[]) =>
  parts.map((p) => (p.kind === 'text' ? p.text : p.kind === 'write' ? `⟦${p.n} WRITE: ${p.text}⟧` : `⟦${p.n} ADAPT: ${p.text}⟧`)).join('')

export const slotCount = (parts: TemplatePart[]) => ({
  write: parts.filter((p) => p.kind === 'write').length,
  adapt: parts.filter((p) => p.kind === 'adapt').length,
})
