const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', '#39': "'" }

export const decodeEntities = (s: string) =>
  s.replace(/&(#x?[0-9a-f]+|[a-z]+[0-9]*);/gi, (m, e: string) => {
    if (e.startsWith('#x') || e.startsWith('#X')) return String.fromCodePoint(Number.parseInt(e.slice(2), 16))
    if (e.startsWith('#')) return String.fromCodePoint(Number.parseInt(e.slice(1), 10))
    return ENTITIES[e.toLowerCase()] ?? m
  })

/** Good-enough HTML to plain text for job descriptions (keeps paragraphs and bullets). */
export const htmlToText = (input: string) => {
  if (!input) return ''
  let s = decodeEntities(input) // many ATSs double-encode
  s = s.replace(/<\s*(script|style)[^>]*>[\s\S]*?<\/\s*\1\s*>/gi, '')
  s = s.replace(/<\s*(br|\/p|\/div|\/h\d|\/li|\/ul|\/ol|\/tr)\s*\/?>/gi, '\n')
  s = s.replace(/<\s*li[^>]*>/gi, '- ')
  s = s.replace(/<[^>]+>/g, '')
  s = decodeEntities(s)
  s = s.replace(/[ \t ]+/g, ' ')
  s = s.replace(/\n\s*\n+/g, '\n\n')
  return s.trim()
}

export const truncate = (s: string | null | undefined, n: number) => (!s ? '' : s.length > n ? `${s.slice(0, n)}…` : s)

export interface TextPage {
  text: string
  offset: number
  totalChars: number
  /** Pass as the offset to read on; null on the last page. */
  nextOffset: number | null
}

/**
 * One page of a long text, so an agent can read all of it: AI clients cut off big tool results.
 * Ends at a line break near the limit when there is one, so pages don't split a line.
 */
export const pageOf = (s: string | null | undefined, offset = 0, limit = 20_000): TextPage => {
  const all = s ?? ''
  const start = Math.max(0, Math.min(Math.floor(offset), all.length))
  let end = Math.min(all.length, start + Math.max(1, Math.floor(limit)))
  if (end < all.length) {
    const nl = all.lastIndexOf('\n', end - 1)
    if (nl > start + limit / 2) end = nl + 1
  }
  return { text: all.slice(start, end), offset: start, totalChars: all.length, nextOffset: end < all.length ? end : null }
}

/** Markdown headings and where each starts, to jump to a section of a long document. */
export const outlineOf = (s: string) => {
  const out: { heading: string; offset: number }[] = []
  let at = 0
  for (const line of s.split('\n')) {
    if (/^#{1,4}\s/.test(line)) out.push({ heading: line.trim(), offset: at })
    at += line.length + 1
  }
  return out
}

/** Parse "$180,000 - $240,000" style ranges into annual numbers. */
export const parseComp = (s: string | null | undefined): { min: number | null; max: number | null } => {
  if (!s) return { min: null, max: null }
  const nums = [...s.matchAll(/\$?\s?(\d{2,3}(?:[,.]\d{3})+|\d{2,3}\s?[kK])/g)].map((m) => {
    const raw = (m[1] ?? '').replace(/[\s,]/g, '')
    return /k$/i.test(raw) ? Number.parseFloat(raw) * 1000 : Number.parseFloat(raw.replace(/\./g, ''))
  })
  const valid = nums.filter((n) => n >= 30_000 && n <= 2_000_000)
  return { min: valid[0] ?? null, max: valid[1] ?? valid[0] ?? null }
}
