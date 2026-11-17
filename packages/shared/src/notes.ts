/**
 * Long notes (a call's summary, an application's or person's dated notes, company notes) are
 * markdown an agent wrote, often as plain paragraphs that open with a label ("Comp: …",
 * "Process (5 interviews):" over a numbered list). These shape them for display.
 */

/** A paragraph that opens with a short label: "Comp:", "**Team:**", "**Take-home**:". */
const LABEL = /^(?:\*\*)?([A-Z][^\n:.!?*#`[\]]{0,39}?)(?:\*\*)?:(?:\*\*)?(?=[ \t\n]|$)[ \t]*\n?/

/** More words than this and it's a sentence with a colon in it, not a label. */
const LABEL_WORDS = 4

const labelBlock = (block: string) => {
  const m = LABEL.exec(block)
  const label = m?.[1]?.trim()
  if (!m || !label || label.split(/\s+/).length > LABEL_WORDS) return block
  // "Comp: the range is…" reads as "Comp" over "The range is…". Only an all-lowercase first word
  // is capitalized, so "iOS" stays as written.
  const rest = block.slice(m[0].length).replace(/^([a-z])(?=[a-z]*[\s,;'’])/, (c) => c.toUpperCase())
  return `#### ${label}${rest.trim() ? `\n\n${rest}` : ''}`
}

/** Markdown with each labeled paragraph's label made a small heading over it. Code blocks are left alone. */
export function structureNote(md: string): string {
  const out: string[] = []
  let fenced = false
  for (const block of md.replace(/\r\n?/g, '\n').trim().split(/\n[ \t]*\n/)) {
    out.push(fenced ? block : labelBlock(block))
    if ((block.match(/^\s*```/gm)?.length ?? 0) % 2) fenced = !fenced
  }
  return out.join('\n\n')
}

/** Worth a collapsed preview: several paragraphs, or more than a few lines' worth of text. */
export const isLongNote = (md: string | null | undefined) => {
  const t = (md ?? '').trim()
  return t.length > 640 || t.split('\n').filter((l) => l.trim()).length > 7
}

/** Short enough to sit on one line beside its date. */
export const isOneLineNote = (md: string | null | undefined) => {
  const t = (md ?? '').trim()
  return t.length <= 220 && !t.includes('\n')
}

const ENTRY = /^- \*\*(\d{4}-\d{2}-\d{2}):\*\*[ \t]?(.*)$/

/**
 * appendNote's dated log ("- **2026-11-17:** …", continuation lines indented two spaces) split into
 * entries, oldest first. Text before the first entry comes back undated. Null when the notes
 * aren't that log, so they're shown as written.
 */
export function datedNotes(md: string | null | undefined): { date: string | null; body: string }[] | null {
  const lines = (md ?? '').replace(/\r\n?/g, '\n').trim().split('\n')
  const entries: { date: string | null; lines: string[] }[] = []
  for (const line of lines) {
    const m = ENTRY.exec(line)
    const last = entries.at(-1)
    if (m) entries.push({ date: m[1]!, lines: [m[2] ?? ''] })
    else if (last?.date && (!line.trim() || /^ {2}/.test(line))) last.lines.push(line.slice(2))
    else if (last?.date) return null
    else if (last) last.lines.push(line)
    else entries.push({ date: null, lines: [line] })
  }
  if (!entries.some((e) => e.date)) return null
  return entries.map((e) => ({ date: e.date, body: e.lines.join('\n').trim() })).filter((e) => e.body)
}

/** Adds a dated entry to notes. A note of several lines stays one entry: its other lines are indented under it. */
export const appendDatedNote = (base: string | null | undefined, date: string, note: string) => {
  const body = note
    .replace(/\r\n?/g, '\n')
    .trim()
    .split('\n')
    .map((l, i) => (i && l.trim() ? `  ${l}` : i ? '' : l))
    .join('\n')
  return `${base?.trim() ? `${base.trimEnd()}\n` : ''}- **${date}:** ${body}`
}

/** Markdown as one line of plain text, for a clamped preview: link text without the URL, list items and paragraphs joined by " · ". */
export const notePreview = (md: string | null | undefined) =>
  (md ?? '')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/^[ \t]*(?:[-*+]|\d+\.)[ \t]+/gm, '')
    .replace(/^#+[ \t]*/gm, '')
    .replace(/\*\*|__|[*`]/g, '')
    .trim()
    .replace(/[ \t]*\n+[ \t]*/g, ' · ')
