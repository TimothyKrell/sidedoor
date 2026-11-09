// The "Questions for <you>" section some packages carry: numbered questions only the user can
// answer, sometimes with an "**Answered …**" line under one. Sidedoor keeps these as questions
// (apps/server/src/services/questions.ts); this reads them out of the markdown.

export interface PackageQuestion {
  text: string
  /** What followed the question on its line ("This is the posting's biggest gap."). */
  why: string | null
  /** The answer noted under it in the package, if any. */
  answer: string | null
}

/**
 * Does an open question hold its application back? A fact about past work doesn't: nothing
 * unconfirmed is claimed, so an answer can only make the application stronger. Those stay optional,
 * unless a form asked, since then a field is waiting on it.
 */
export const holdsApplication = (q: { about: string; saveTo: string | null; askedBy: string }) => q.askedBy === 'fill' || q.about !== 'you' || q.saveTo !== 'experience'

const HEADING = /^##\s+questions for\b/i

const section = (md: string | null | undefined) => {
  const lines = (md ?? '').split('\n')
  const start = lines.findIndex((l) => HEADING.test(l.trim()))
  if (start < 0) return null
  let end = start + 1
  while (end < lines.length && !/^#{1,2}\s/.test(lines[end]!)) end++
  return { lines, start, end }
}

export const packageQuestions = (md: string | null | undefined): PackageQuestion[] => {
  const s = section(md)
  if (!s) return []
  const out: PackageQuestion[] = []
  for (const l of s.lines.slice(s.start + 1, s.end)) {
    const item = l.match(/^(?:\d+[.)]|[-*])\s+(?:\[[ xX]\]\s+)?(.+)$/)
    if (item) {
      // The question ends at its last "?"; what follows says why it's asked, unless it's only a
      // short hint like "(yes/no)".
      const all = item[1]!.trim()
      // A note left in the list ("**Answered Oct 30:** Rust."), not a question.
      if (/^\*\*Answered\b/i.test(all)) continue
      const m = all.match(/^(.*\?)\s+(\S.*)$/)
      const split = m && !/^\([^)]{0,40}\)$/.test(m[2]!)
      out.push({ text: split ? m[1]! : all, why: split ? m[2]! : null, answer: null })
      continue
    }
    // "   - **Answered Oct 30, 2026 (saved in Experience):** Yes, it used WebSockets."
    const ans = l.match(/^\s+[-*]\s+\*\*Answered[^*]*\*\*\s*(.*)$/i)
    const last = out.at(-1)
    if (ans && last) last.answer = ans[1]!.trim() || last.answer
  }
  return out
}

/** The package without its "Questions for" section (the app lists those as questions to answer). */
export const withoutQuestions = (md: string | null | undefined) => {
  const s = section(md)
  if (!s) return md ?? ''
  return [...s.lines.slice(0, s.start), ...s.lines.slice(s.end)].join('\n').replace(/\n{3,}/g, '\n\n')
}
