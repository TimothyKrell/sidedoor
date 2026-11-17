import { expect, test } from 'vitest'
import { appendDatedNote, datedNotes, isLongNote, isOneLineNote, notePreview, structureNote } from '@sidedoor/shared/notes'
import { toolsFor } from '../src/mcp/tools'
import { createApplication, getApplication } from '../src/services/applications'
import { today } from '../src/ids'

// The shape a call summary comes in: an opening, labeled paragraphs, a numbered list under a label.
const CALL = [
  'Recruiter screen, about 30 min. It went well: notes go to the hiring manager. Update by Wednesday.',
  'Company: Series E, about 400 people.\nNext.js hosting was a big unlock.',
  'Comp: the range is $198,000–$248,625.',
  '**Team:** 1 staff, 4 seniors.',
  'Process (5 interviews):\n1. Hiring manager: goes deep on the resume.\n2. Coding screen.',
  'She asked about:\n- Why leave: stability.\n- Start date: now.',
  'They booked the 30-minute call themselves: Tuesday at 4pm.',
].join('\n\n')

test('a label opening a paragraph becomes a small heading over it', () => {
  const md = structureNote(CALL)
  expect(md).toContain('#### Company\n\nSeries E, about 400 people.\nNext.js hosting')
  // An all-lowercase first word after a label is capitalized.
  expect(md).toContain('#### Comp\n\nThe range is $198,000–$248,625.')
  expect(md).toContain('#### Team\n\n1 staff, 4 seniors.')
  expect(md).toContain('#### Process (5 interviews)\n\n1. Hiring manager: goes deep on the resume.')
  expect(md).toContain('#### She asked about\n\n- Why leave: stability.')
  // A sentence with a colon in it isn't a label; neither is the opening's "It went well:".
  expect(md).toContain('\n\nThey booked the 30-minute call themselves: Tuesday at 4pm.')
  expect(md.startsWith('Recruiter screen')).toBe(true)
})

test('times, links and code are left as written', () => {
  expect(structureNote('4:00pm call\n\nhttps://example.com: the page')).toBe('4:00pm call\n\nhttps://example.com: the page')
  expect(structureNote('```\n\nNote: inside\n```')).toBe('```\n\nNote: inside\n```')
  expect(structureNote('Note: iOS first')).toBe('#### Note\n\niOS first')
})

test('long notes get a preview; short ones stay on one line', () => {
  expect(isLongNote(CALL)).toBe(true)
  expect(isLongNote('Sent the intro.')).toBe(false)
  expect(isOneLineNote('Sent the intro.')).toBe(true)
  expect(isOneLineNote('Sent.\nReplied.')).toBe(false)
})

test('appendNote keeps a note of several lines as one dated entry', async () => {
  const a = createApplication({ companyName: 'Acme', role: 'Engineer' })!
  const update = toolsFor('connected').find((t) => t.name === 'update_application')!
  expect((await update.handler({ id: a.id, appendNote: 'Applied.' })).isError).toBeFalsy()
  expect((await update.handler({ id: a.id, appendNote: 'Screen went well.\n\nProcess:\n1. Coding\n2. Design' })).isError).toBeFalsy()

  const notes = getApplication(a.id)!.notesMd!
  expect(notes).toBe(`- **${today()}:** Applied.\n- **${today()}:** Screen went well.\n\n  Process:\n  1. Coding\n  2. Design`)
  expect(datedNotes(notes)).toEqual([
    { date: today(), body: 'Applied.' },
    { date: today(), body: 'Screen went well.\n\nProcess:\n1. Coding\n2. Design' },
  ])
})

test('notes that aren\'t a dated log are shown as written', () => {
  expect(datedNotes('Just some notes.\n\nMore.')).toBeNull()
  expect(datedNotes('- **2026-11-17:** One\nNot indented')).toBeNull()
  expect(datedNotes('Older notes\n- **2026-11-17:** One')).toEqual([
    { date: null, body: 'Older notes' },
    { date: '2026-11-17', body: 'One' },
  ])
  expect(appendDatedNote(null, '2026-11-17', 'One')).toBe('- **2026-11-17:** One')
})

test('a preview is plain text: link text without the URL, items joined', () => {
  expect(notePreview('- Quoted at the **launch** ([CMSWire](https://example.com/a)).\n- Hook: `CRDTs`')).toBe('Quoted at the launch (CMSWire). · Hook: CRDTs')
})
