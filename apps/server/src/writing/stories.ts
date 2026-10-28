import { today } from '../ids'
import { appendDoc, docBody, getDoc, setDoc } from '../services/documents'

// Story bank: the "stories" document, one "## <title>" section per career story, captured by the
// story-interview chat mode. Append-only from agents; the user can edit it freely.

const HEADER = `# Story bank

Specific career stories in your own words, captured in story interviews. Each has the
who/what/where/when/why/how, the numbers, and a ready-to-use version for cover letters,
application answers, interviews and outreach. Facts here that aren't in your Experience document
yet are listed under "Facts to confirm"; agents treat them as unconfirmed until you add them there.
`

export interface StoryInput {
  title: string
  role: string
  date: string
  who: string
  what: string
  where: string
  when: string
  why: string
  how: string
  decision?: string | undefined
  numbers?: string[] | undefined
  readerContext?: string | undefined
  readyToUse: string
  factsToConfirm?: string[] | undefined
}

export interface Story {
  title: string
  body: string
}

const read = () => docBody('stories')

export const listStories = (): Story[] => {
  const md = read()
  const out: Story[] = []
  const re = /^## (.+)$/gm
  const heads = [...md.matchAll(re)]
  heads.forEach((m, i) => {
    const from = (m.index ?? 0) + m[0].length
    const to = heads[i + 1]?.index ?? md.length
    out.push({ title: m[1]!.trim(), body: md.slice(from, to).trim() })
  })
  return out
}

const oneLine = (s: string | undefined) => (s ?? '').replace(/\s*\n\s*/g, ' ').trim()

export const formatStory = (s: StoryInput) => {
  const lines = [
    `## ${oneLine(s.title)}`,
    '',
    `- **Role:** ${oneLine(s.role)}`,
    `- **Date:** ${oneLine(s.date)}`,
    `- **Captured:** ${today()} (Sidedoor story interview)`,
    '',
    `**Who:** ${s.who.trim()}`,
    '',
    `**What:** ${s.what.trim()}`,
    '',
    `**Where:** ${s.where.trim()}`,
    '',
    `**When:** ${s.when.trim()}`,
    '',
    `**Why:** ${s.why.trim()}`,
    '',
    `**How:** ${s.how.trim()}`,
  ]
  if (s.decision?.trim()) lines.push('', `**The decision:** ${s.decision.trim()}`)
  lines.push('', '**Numbers:**', ...(s.numbers?.length ? s.numbers.map((n) => `- ${oneLine(n)}`) : ['- (none given)']))
  if (s.readerContext?.trim()) lines.push('', `**What a reader wouldn't know:** ${s.readerContext.trim()}`)
  lines.push('', '### Ready to use', '', s.readyToUse.trim())
  lines.push('', '### Facts to confirm', '', ...(s.factsToConfirm?.length ? s.factsToConfirm.map((f) => `- [ ] ${oneLine(f)}`) : ['- (nothing new)']))
  return `${lines.join('\n')}\n`
}

/** Append one story section, creating the file with a header if needed. */
export const appendStory = (s: StoryInput) => {
  const title = oneLine(s.title)
  if (!title) throw new Error('title is required')
  if (listStories().some((x) => x.title.toLowerCase() === title.toLowerCase())) throw new Error(`A story titled "${title}" already exists; pick a more specific title.`)
  if (getDoc('stories').isDefault || !read().trim()) setDoc('stories', HEADER)
  appendDoc('stories', formatStory(s))
  return { title }
}

export interface StorySeed {
  /** "Acme · Staff Engineer": the headings above the bullet. */
  role: string
  date: string
  text: string
  hasNumber: boolean
}

/**
 * Seeds for interviews: each substantial bullet in the Experience document, labelled with the
 * headings above it. Works with any heading structure.
 */
export const storySeeds = (): StorySeed[] => {
  const lines = docBody('experience').split('\n')
  const seeds: StorySeed[] = []
  const heads: string[] = []
  let bullet: string | null = null
  const label = () => heads.filter(Boolean).slice(-2).join(' · ')
  const flush = () => {
    // Skip the default template's placeholders ("<Company> — <Title>", "<what you did>").
    const placeholder = /<[^>]{2,40}>/.test(bullet ?? '') || heads.some((h) => /<[^>]{2,40}>/.test(h))
    if (bullet && heads.length && bullet.length > 30 && !placeholder && !/^[\w ]{1,20}:\s*\S{0,40}$/.test(bullet)) {
      const [r, d] = label().split('|').map((x) => x.trim())
      seeds.push({ role: r ?? '', date: d ?? (r?.match(/\(([^)]*\d{4}[^)]*)\)/)?.[1] ?? ''), text: bullet.trim(), hasNumber: /\d/.test(bullet) })
    }
    bullet = null
  }
  for (const line of lines) {
    const h = /^(#{1,4}) (.+)$/.exec(line)
    if (h) {
      flush()
      const level = h[1]!.length
      heads.length = Math.max(0, level - 1)
      heads[level - 1] = level === 1 ? '' : h[2]!.trim()
      continue
    }
    const b = /^\s*[-*] (.+)$/.exec(line)
    if (b && !/^\s{2,}/.test(line)) {
      flush()
      bullet = b[1]!
    } else if (bullet && /^\s+\S/.test(line)) bullet += ` ${line.trim()}`
    else flush()
  }
  flush()
  return seeds
}
