import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { expect, test } from 'vitest'
import { paths } from '../src/config'
import { attachFile, createApplication, getApplication, removeAttachment } from '../src/services/applications'
import { toolsFor } from '../src/mcp/tools'

const PDF = (body = 'one') => Buffer.from(`%PDF-1.7\n${body}\n%%EOF\n`)
const app = () => createApplication({ companyName: 'Acme', role: 'UX Researcher' })!

test('an attached PDF is kept under the application, and attaching again under the same label replaces it', () => {
  const a = app()
  const first = attachFile(a.id, { label: 'Portfolio', name: '/home/x/My Portfolio.pdf', bytes: PDF() })
  expect(first).toMatchObject({ label: 'Portfolio', name: 'My-Portfolio.pdf', file: `attachments/${a.id}/My-Portfolio.pdf` })
  attachFile(a.id, { label: 'Cover letter', name: 'letter.pdf', bytes: PDF() })
  const again = attachFile(a.id, { label: 'portfolio', name: 'v2.pdf', bytes: PDF('two') })
  const kept = getApplication(a.id)!.attachments!
  expect(kept.map((x) => x.label).sort()).toEqual(['Cover letter', 'portfolio'])
  // The file it replaced is gone; the new one is on disk.
  expect(existsSync(resolve(paths.files, first.file))).toBe(false)
  expect(readFileSync(resolve(paths.files, again.file), 'latin1')).toContain('two')
})

test('two labels with the same file name get separate files', () => {
  const a = app()
  const one = attachFile(a.id, { label: 'Portfolio', name: 'tim.pdf', bytes: PDF() })
  const two = attachFile(a.id, { label: 'Work sample', name: 'tim.pdf', bytes: PDF() })
  expect(two.file).not.toBe(one.file)
  expect(existsSync(resolve(paths.files, one.file))).toBe(true)
})

test('only PDFs can be attached, and only with a label', () => {
  const a = app()
  expect(() => attachFile(a.id, { label: 'Portfolio', name: 'notes.txt', bytes: Buffer.from('ssh-rsa AAAA') })).toThrow(/Only PDF/)
  expect(() => attachFile(a.id, { label: '  ', name: 'p.pdf', bytes: PDF() })).toThrow(/label/)
  expect(getApplication(a.id)!.attachments).toBeNull()
})

test('removing an attachment deletes its file', () => {
  const a = app()
  const x = attachFile(a.id, { label: 'Portfolio', name: 'p.pdf', bytes: PDF() })
  removeAttachment(a.id, 'PORTFOLIO')
  expect(getApplication(a.id)!.attachments).toEqual([])
  expect(existsSync(resolve(paths.files, x.file))).toBe(false)
})

test('an agent attaches a PDF from disk, and get_application lists it', async () => {
  const a = app()
  const dir = mkdtempSync(join(tmpdir(), 'attach-'))
  writeFileSync(join(dir, 'portfolio.pdf'), PDF())
  writeFileSync(join(dir, 'secret.txt'), 'hunter2')
  const tools = new Map(toolsFor('connected').map((t) => [t.name, t]))
  const call = async (name: string, args: Record<string, unknown>) => (await tools.get(name)!.handler(args)).content[0]!.text
  expect(await call('attach_file', { applicationId: a.id, label: 'Portfolio', path: join(dir, 'secret.txt') })).toMatch(/Only PDF/)
  expect(JSON.parse(await call('attach_file', { applicationId: a.id, label: 'Portfolio', path: join(dir, 'portfolio.pdf') }))).toMatchObject({ attached: true, name: 'portfolio.pdf' })
  expect(JSON.parse(await call('get_application', { id: a.id })).attachments).toMatchObject([{ label: 'Portfolio', name: 'portfolio.pdf' }])
})
