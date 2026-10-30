import { beforeEach, expect, test } from 'vitest'
import { toolsFor } from '../src/mcp/tools'
import { appendDoc, applyDocEdit, editDoc, getDoc, listRevisions, revertRevision, setDoc } from '../src/services/documents'

const DOC = `# Experience

## Skills (Oct 23)

- Has used OpenTelemetry, Grafana and Prometheus.
- TypeScript, Go.

### Languages

- English

## Roles

- Staff engineer at a company.
`

const tool = (name: string) => toolsFor('grokbot').find((t) => t.name === name)!
const call = async (name: string, args: Record<string, unknown>) => {
  const r = await tool(name).handler(args)
  const text = r.content[0]!.text
  return { error: r.isError ? text : null, json: r.isError ? null : (JSON.parse(text) as Record<string, unknown>) }
}

beforeEach(() => {
  setDoc('experience', DOC)
})

test('replace_section replaces everything under a heading, subsections included, up to the next heading of its level', () => {
  const out = applyDocEdit(DOC, { op: 'replace_section', heading: '## Skills (Oct 23)', text: '- Familiar with OpenTelemetry.\n- TypeScript, Go.' })
  expect(out).toBe('# Experience\n\n## Skills (Oct 23)\n\n- Familiar with OpenTelemetry.\n- TypeScript, Go.\n\n## Roles\n\n- Staff engineer at a company.\n')
  // The heading text alone matches too, and a leading heading line renames the section.
  const renamed = applyDocEdit(DOC, { op: 'replace_section', heading: 'Roles', text: '## Work\n\n- Staff engineer.' })
  expect(renamed.endsWith('## Work\n\n- Staff engineer.\n')).toBe(true)
  expect(renamed).toContain('### Languages\n\n- English\n\n## Work')
  expect(() => applyDocEdit(DOC, { op: 'replace_section', heading: '## Nope', text: 'x' })).toThrow(/No heading "## Nope"\. Headings: # Experience \| ## Skills/)
  expect(() => applyDocEdit(`## A\n\none\n\n## A\n\ntwo\n`, { op: 'replace_section', heading: 'A', text: 'x' })).toThrow(/matches 2 headings/)
})

test('delete_section and insert_under_heading', () => {
  expect(applyDocEdit(DOC, { op: 'delete_section', heading: '### Languages' })).toBe(DOC.replace('### Languages\n\n- English\n\n', ''))
  expect(applyDocEdit(DOC, { op: 'delete_section', heading: '## Roles' })).toBe(DOC.slice(0, DOC.indexOf('## Roles')).trimEnd() + '\n')
  expect(applyDocEdit(DOC, { op: 'insert_under_heading', heading: '## Roles', text: '- Lead at another.' })).toBe(`${DOC}\n- Lead at another.\n`.replace('company.\n\n\n', 'company.\n\n'))
  expect(applyDocEdit(DOC, { op: 'insert_under_heading', heading: '### Languages', text: '- Spanish', position: 'start' })).toContain('### Languages\n\n- Spanish\n\n- English\n\n## Roles')
})

test('replace_text needs exactly one match, and deleting a whole line takes its line break', () => {
  const fixed = applyDocEdit(DOC, { op: 'replace_text', find: 'Has used OpenTelemetry, Grafana', replace: 'Familiar with OpenTelemetry; has used Grafana' })
  expect(fixed).toContain('- Familiar with OpenTelemetry; has used Grafana and Prometheus.\n- TypeScript, Go.')
  expect(() => applyDocEdit(DOC, { op: 'replace_text', find: 'Kubernetes', replace: 'x' })).toThrow(/not in the document/)
  expect(() => applyDocEdit(DOC, { op: 'replace_text', find: 'engineer', replace: 'x' })).not.toThrow()
  expect(() => applyDocEdit(DOC, { op: 'replace_text', find: '\n- ', replace: '\n* ' })).toThrow(/appears 4 times/)
  expect(() => applyDocEdit(DOC, { op: 'replace_text', find: '', replace: 'x' })).toThrow(/empty/)
  const gone = applyDocEdit(DOC, { op: 'replace_text', find: '- Has used OpenTelemetry, Grafana and Prometheus.', replace: '' })
  expect(gone).toContain('## Skills (Oct 23)\n\n- TypeScript, Go.\n')
  expect(applyDocEdit('a\nb', { op: 'replace_text', find: 'b', replace: '' })).toBe('a')
})

test('every edit keeps a revision, and reverting restores the exact prior text', () => {
  const start = getDoc('experience').body
  editDoc('experience', { op: 'replace_text', find: 'Has used OpenTelemetry', replace: 'Familiar with OpenTelemetry' }, { by: 'agent', reason: 'user: only familiar with it' })
  const [rev] = listRevisions('experience')
  expect(rev).toMatchObject({ by: 'agent', reason: 'user: only familiar with it', change: { removed: 'Has used', added: 'Familiar with' } })
  expect(getDoc('experience').body).toContain('Familiar with OpenTelemetry')

  revertRevision(rev!.id, { by: 'user' })
  expect(getDoc('experience').body).toBe(start)
  expect(listRevisions('experience')[0]).toMatchObject({ by: 'user', reason: expect.stringMatching(/^reverted /) })

  // Two edits: reverting the older one would undo the newer one too, so it asks first.
  editDoc('experience', { op: 'insert_under_heading', heading: '## Roles', text: '- One.' })
  editDoc('experience', { op: 'insert_under_heading', heading: '## Roles', text: '- Two.' })
  const [newest, older] = listRevisions('experience')
  expect(() => revertRevision(older!.id)).toThrow(/1 later revision/)
  revertRevision(newest!.id)
  revertRevision(older!.id)
  expect(getDoc('experience').body).toBe(start)
})

test('reverting the first write puts the template back', () => {
  expect(getDoc('writing').isDefault).toBe(true)
  appendDoc('writing', '## Voice\n\nShort and warm.')
  expect(getDoc('writing').body).toBe('## Voice\n\nShort and warm.\n')
  const [rev] = listRevisions('writing')
  expect(rev!.fromTemplate).toBe(true)
  revertRevision(rev!.id)
  expect(getDoc('writing').isDefault).toBe(true)
})

test('an edit that removes a large part of the document is refused unless confirmed', () => {
  const big = `# Experience\n\n## Old\n\n${'A fact.\n'.repeat(200)}\n## Keep\n\nShort.\n`
  setDoc('experience', big)
  const n = listRevisions('experience').length
  expect(() => editDoc('experience', { op: 'delete_section', heading: '## Old' })).toThrow(/confirmLargeDeletion/)
  expect(() => editDoc('experience', { op: 'replace_all', text: 'Short.' })).toThrow(/This would remove \d+ of Experience/)
  expect(getDoc('experience').body).toBe(big)
  expect(listRevisions('experience').length).toBe(n)
  editDoc('experience', { op: 'delete_section', heading: '## Old' }, { confirmLargeDeletion: true })
  expect(getDoc('experience').body).toBe('# Experience\n\n## Keep\n\nShort.\n')
  // Small edits don't need it, even in a small document.
  editDoc('experience', { op: 'replace_text', find: 'Short.\n', replace: '' })
  expect(getDoc('experience').body).toBe('# Experience\n\n## Keep\n\n')
})

test('Grok Bot gets the edit and history tools, with descriptions that say when to use them', async () => {
  const names = toolsFor('grokbot').map((t) => t.name)
  expect(names).toEqual(expect.arrayContaining(['update_profile_doc', 'edit_profile_doc', 'list_profile_doc_revisions', 'revert_profile_doc']))
  expect(tool('edit_profile_doc').description).toMatch(/instead of appending/)
  expect(tool('update_profile_doc').description).toMatch(/edit_profile_doc/)

  const fixed = await call('edit_profile_doc', { key: 'experience', op: 'replace_text', find: 'Has used OpenTelemetry, Grafana', replace: 'Familiar with OpenTelemetry; has used Grafana', reason: 'user: only familiar with OpenTelemetry' })
  expect(fixed.json).toMatchObject({ saved: true })
  const twice = await call('edit_profile_doc', { key: 'experience', op: 'replace_text', find: '- ', replace: '* ', reason: 'x' })
  expect(twice.error).toMatch(/appears \d+ times/)
  const missing = await call('edit_profile_doc', { key: 'experience', op: 'replace_section', heading: '## Roles', reason: 'x' })
  expect(missing.error).toMatch(/replace_section needs text/)

  const list = await call('list_profile_doc_revisions', { key: 'experience' })
  const revs = (list.json!.revisions as { id: string; by: string; reason: string }[])
  expect(revs[0]).toMatchObject({ by: 'agent', reason: 'user: only familiar with OpenTelemetry' })
  const back = await call('revert_profile_doc', { revisionId: revs[0]!.id, reason: 'undo' })
  expect(back.json).toMatchObject({ key: 'experience' })
  expect(getDoc('experience').body).toBe(DOC)
})
