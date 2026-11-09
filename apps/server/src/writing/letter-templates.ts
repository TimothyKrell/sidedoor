import { parseTemplate } from '@sidedoor/shared/letter-template'
import { newId } from '../ids'
import { getSettings, updateSettings } from '../settings'

// The user's cover letter templates, kept in settings. Settings → Cover letters edits them as a
// whole section; these are for agents and the writer, so the two edit the same list.

export type LetterTemplate = { id: string; name: string; body: string }

export const listLetterTemplates = () => {
  const s = getSettings().coverLetters
  return s.templates.map((t) => ({ ...t, isDefault: t.id === s.defaultTemplate }))
}

/** By id, or by name ignoring case, so an agent can say "the startup one". */
export const findLetterTemplate = (ref: string): LetterTemplate | undefined => {
  const ts = getSettings().coverLetters.templates
  const r = ref.trim().toLowerCase()
  return ts.find((t) => t.id === ref) ?? ts.find((t) => t.name.trim().toLowerCase() === r)
}

/** The template prep writes from, if one is set as the default and still exists. */
export const defaultLetterTemplate = () => {
  const s = getSettings().coverLetters
  return s.templates.find((t) => t.id === s.defaultTemplate)
}

export function saveLetterTemplate(o: { id?: string; name: string; body: string; makeDefault?: boolean }) {
  if (!o.name.trim()) throw new Error('A template needs a name.')
  if (!parseTemplate(o.body).some((p) => p.kind !== 'text')) throw new Error('A template needs at least one [part for the AI to write] or {part for it to adapt}.')
  const s = getSettings().coverLetters
  const id = o.id && s.templates.some((t) => t.id === o.id) ? o.id : newId('tpl_')
  const t = { id, name: o.name.trim(), body: o.body }
  const templates = s.templates.some((x) => x.id === id) ? s.templates.map((x) => (x.id === id ? t : x)) : [...s.templates, t]
  updateSettings('coverLetters', { templates, defaultTemplate: o.makeDefault ? id : o.makeDefault === false && s.defaultTemplate === id ? null : s.defaultTemplate })
  return { ...t, isDefault: getSettings().coverLetters.defaultTemplate === id }
}

export function deleteLetterTemplate(id: string) {
  const s = getSettings().coverLetters
  if (!s.templates.some((t) => t.id === id)) throw new Error('No template with that id.')
  updateSettings('coverLetters', { templates: s.templates.filter((t) => t.id !== id), defaultTemplate: s.defaultTemplate === id ? null : s.defaultTemplate })
}

/** Null: prep writes the letter freely, in their voice. */
export function setDefaultLetterTemplate(id: string | null) {
  if (id && !getSettings().coverLetters.templates.some((t) => t.id === id)) throw new Error('No template with that id.')
  updateSettings('coverLetters', { defaultTemplate: id })
}
