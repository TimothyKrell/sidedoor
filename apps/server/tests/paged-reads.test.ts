import { expect, test } from 'vitest'
import { toolsFor } from '../src/mcp/tools'
import { createApplication } from '../src/services/applications'
import { setDoc } from '../src/services/documents'
import { pageOf } from '../src/text'

const call = async (name: string, args: Record<string, unknown>) => {
  const t = toolsFor('app').find((x) => x.name === name)!
  const r = await t.handler(args)
  return JSON.parse(r.content[0]!.text) as Record<string, unknown>
}

test('pages of a long text cover all of it, end at line breaks, and say where to read on', () => {
  const text = Array.from({ length: 400 }, (_, i) => `line ${i} ${'x'.repeat(100)}`).join('\n')
  let at: number | null = 0
  let got = ''
  while (at != null) {
    const p = pageOf(text, at, 10_000)
    expect(p.text.length).toBeLessThanOrEqual(10_000)
    if (p.nextOffset != null) expect(p.text.endsWith('\n')).toBe(true)
    got += p.text
    at = p.nextOffset
  }
  expect(got).toBe(text)
  expect(pageOf('short', 0, 10_000)).toEqual({ text: 'short', offset: 0, totalChars: 5, nextOffset: null })
})

test('agents can read all of a long Experience document, newest sections included', async () => {
  const old = `# Experience\n\n${'Did things at a company.\n'.repeat(2500)}`
  setDoc('experience', `${old}\n## Confirmed answers (Oct 30)\nStarts in two weeks.\n`)
  const first = await call('get_profile_doc', { key: 'experience' })
  expect(first.totalChars).toBeGreaterThan(50_000)
  expect(first.nextOffset).toBeTypeOf('number')
  const sections = first.sections as { heading: string; offset: number }[]
  const newest = sections.find((s) => s.heading.startsWith('## Confirmed answers'))!
  const jump = await call('get_profile_doc', { key: 'experience', offset: newest.offset })
  expect(String(jump.body)).toContain('Starts in two weeks.')
  let body = String(first.body)
  let next = first.nextOffset as number | null
  while (next != null) {
    const p = await call('get_profile_doc', { key: 'experience', offset: next })
    body += String(p.body)
    next = p.nextOffset as number | null
  }
  expect(body).toContain('Starts in two weeks.')
  expect(body.length).toBe(first.totalChars)
})

test('a long package reads in pages through get_application', async () => {
  const pkg = `# Package\n${'An answer line.\n'.repeat(1500)}### Last question\nThe end.\n`
  const a = createApplication({ companyName: 'Longco', role: 'Engineering Manager', stage: 'review', packageMd: pkg })
  const first = await call('get_application', { id: a.id })
  expect(first.packageTotalChars).toBe(pkg.length)
  expect(String(first.package)).not.toContain('The end.')
  let body = String(first.package)
  let next = first.packageNextOffset as number | null
  while (next != null) {
    const p = await call('get_application', { id: a.id, packageOffset: next })
    body += String(p.package)
    next = p.packageNextOffset as number | null
  }
  expect(body).toBe(pkg)
})
