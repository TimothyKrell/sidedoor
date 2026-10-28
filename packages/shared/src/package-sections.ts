// Finds the prose the user will paste into an application inside a prep package (package.md):
// the cover letter and every long free-text answer ("### Q<n>: <question>" under the form table).
// Offsets let the editor pass and the UI replace one section without touching the rest.

export interface ProseSection {
  /** 'cover-letter' or 'q:<n>' */
  key: string
  title: string
  text: string
  start: number
  end: number
}

const trimmedRange = (md: string, from: number, to: number) => {
  let a = from
  let b = to
  while (a < b && /\s/.test(md[a]!)) a++
  while (b > a && /\s/.test(md[b - 1]!)) b--
  return { start: a, end: b, text: md.slice(a, b) }
}

/** Next heading of level <= `level` (e.g. 2 → '## ' or '# '), or end of text. */
const nextHeading = (md: string, from: number, level: number) => {
  const re = new RegExp(`^#{1,${level}} `, 'gm')
  re.lastIndex = from
  const m = re.exec(md)
  return m ? m.index : md.length
}

export function extractProseSections(md: string | null | undefined): ProseSection[] {
  if (!md) return []
  const out: ProseSection[] = []
  const q = /^###\s+Q(\d+)[:.)]?\s*(.*)$/gm
  for (const m of md.matchAll(q)) {
    const bodyFrom = (m.index ?? 0) + m[0].length
    const r = trimmedRange(md, bodyFrom, nextHeading(md, bodyFrom, 3))
    if (r.text.length >= 40) out.push({ key: `q:${m[1]}`, title: `Q${m[1]}: ${m[2]!.trim()}`, ...r })
  }
  const cl = /^##\s+Cover letter\s*$/im.exec(md)
  if (cl) {
    const bodyFrom = cl.index + cl[0].length
    const r = trimmedRange(md, bodyFrom, nextHeading(md, bodyFrom, 2))
    if (r.text.length >= 80 && !/^_?not requested/i.test(r.text)) out.push({ key: 'cover-letter', title: 'Cover letter', ...r })
  }
  return out.sort((a, b) => a.start - b.start)
}

/** Replace sections by key (applied back to front so offsets stay valid). */
export function replaceSections(md: string, replacements: Record<string, string>) {
  let next = md
  const secs = extractProseSections(md).filter((s) => replacements[s.key] !== undefined).sort((a, b) => b.start - a.start)
  for (const s of secs) next = next.slice(0, s.start) + replacements[s.key]! + next.slice(s.end)
  return next
}
