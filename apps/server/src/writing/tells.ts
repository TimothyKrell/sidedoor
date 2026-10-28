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
