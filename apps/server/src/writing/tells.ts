import { checkTellsWith, type TellReport, type TellRule } from '@sidedoor/shared/tells'
import { docBody, getDoc } from '../services/documents'

let cache: { key: string; rules: TellRule[] } | null = null

/** Rules from the "tells" document (JSON). Re-parsed when it changes. Empty if invalid. */
export const loadTellRules = (): TellRule[] => {
  const d = getDoc('tells')
  const key = `${d.updatedAt ?? 'default'}:${d.body.length}`
  if (cache?.key === key) return cache.rules
  try {
    const parsed = JSON.parse(d.body) as { rules?: unknown }
    const rules = Array.isArray(parsed.rules) ? (parsed.rules as TellRule[]).filter((r) => r && typeof r.pattern === 'string' && typeof r.weight === 'number') : []
    cache = { key, rules }
    return rules
  } catch (e) {
    console.error('[tells] could not parse the writing check rules', e)
    return cache?.rules ?? []
  }
}

export const checkTells = (text: string): TellReport => checkTellsWith(loadTellRules(), text)

export const writingRules = () => docBody('writing')

const VOICE_HEADING = /^##[ \t]+How I actually sound[ \t]*$/im
const NO_VOICE = "(none saved yet: go by anything in their own words in Experience)"

/** The user's own unpolished lines from their writing style, for what has to sound like them. */
export const voiceSamples = (rules = writingRules()) => {
  const m = VOICE_HEADING.exec(rules)
  if (!m) return NO_VOICE
  const rest = rules.slice(m.index + m[0].length)
  const next = rest.search(/^##[ \t]/m)
  const lines = (next < 0 ? rest : rest.slice(0, next)).split('\n').filter((l) => /^\s*[-*]\s+\S/.test(l) && !l.includes('(your words here)'))
  return lines.join('\n') || NO_VOICE
}

/** The figures in a text, to catch any that weren't in what it was written from. */
export const numbersIn = (s: string) => s.match(/\d+(?:[.,]\d+)*/g) ?? []
