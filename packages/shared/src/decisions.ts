// The "Needs your decision" checklist in an application package: items the AI couldn't settle
// (a salary number, a claim it couldn't verify). Parsed from the package markdown and toggled in it.

export interface Decision {
  /** Line index in the package. */
  line: number
  text: string
  done: boolean
  /** Your answer, when you gave one instead of accepting it as is. */
  answer: string | null
}

/** How an answer is kept on the decision's line: `- [x] <item> → You: <answer>`. */
const ANSWER = ' → You: '

const HEADING = /^##\s+needs your decision\s*$/i

export const decisionsOf = (md: string | null | undefined): Decision[] => {
  const lines = (md ?? '').split('\n')
  const start = lines.findIndex((l) => HEADING.test(l.trim()))
  if (start < 0) return []
  const out: Decision[] = []
  for (let i = start + 1; i < lines.length; i++) {
    const l = lines[i]!
    if (/^#{1,2}\s/.test(l)) break
    const m = l.match(/^\s*[-*]\s+\[( |x|X)\]\s+(.*)$/)
    if (m) {
      const [text, answer] = m[2]!.split(ANSWER)
      out.push({ line: i, text: text!.trim(), done: m[1] !== ' ', answer: answer?.trim() || null })
    }
  }
  return out
}

/** Settle (or reopen) one decision, optionally with your answer. */
export const setDecisionLine = (md: string, line: number, done: boolean, answer?: string | null) => {
  const lines = md.split('\n')
  const l = lines[line]
  if (l === undefined) return md
  const m = l.match(/^(\s*[-*]\s+)\[( |x|X)\]\s+(.*)$/)
  if (!m) return md
  const text = m[3]!.split(ANSWER)[0]!.trim()
  const a = answer?.replace(/\s+/g, ' ').trim()
  lines[line] = `${m[1]}[${done ? 'x' : ' '}] ${text}${done && a ? `${ANSWER}${a}` : ''}`
  return lines.join('\n')
}

/** The package without its decisions section (the app shows those as a checklist). */
export const withoutDecisions = (md: string | null | undefined) => {
  const lines = (md ?? '').split('\n')
  const start = lines.findIndex((l) => HEADING.test(l.trim()))
  if (start < 0) return md ?? ''
  let end = start + 1
  while (end < lines.length && !/^#{1,2}\s/.test(lines[end]!)) end++
  return [...lines.slice(0, start), ...lines.slice(end)].join('\n').replace(/\n{3,}/g, '\n\n')
}
