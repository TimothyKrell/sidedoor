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
