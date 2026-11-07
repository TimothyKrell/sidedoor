import { afterEach, expect, test, vi } from 'vitest'

const ai = vi.hoisted(() => ({ reply: { letter: '' } as unknown, fail: false, prompts: [] as string[], opts: [] as Record<string, unknown>[] }))
vi.mock('../src/ai', async (orig) => ({
  ...(await orig<typeof import('../src/ai')>()),
  runJob: async (o: { prompt: string }) => {
    ai.prompts.push(o.prompt)
    ai.opts.push(o)
    if (ai.fail) throw new Error('no AI')
    return { text: '', data: ai.reply, log: [], costUsd: 0, provider: 'claude', model: 'm' }
  },
}))

const { restyleCoverLetter, writeCoverLetter } = await import('../src/writing/cover-letter')
const { createApplication, getApplication } = await import('../src/services/applications')
const { setDoc } = await import('../src/services/documents')

const DRAFT = 'Initech makes reports people dread, and I have built reporting tools for fourteen long years now.'
const pkg = (letter: string) => `# Review\n\n## Application form\n\n### Q1: Why us?\nBecause I like the way your team writes about its work.\n\n## Cover letter\n${letter}\n\n## Uploads\n- [ ] Resume\n`
const app = (companyName: string, letter = DRAFT) => createApplication({ companyName, role: 'Engineer', stage: 'review', packageMd: pkg(letter) })

afterEach(() => {
  ai.reply = { letter: '' }
  ai.fail = false
  ai.prompts = []
  ai.opts = []
})

test("the new letter replaces only the letter, and the user's own words and the draft reach the writer", async () => {
  setDoc('writing', '# How I write\n\n## How I actually sound\n- "Screw it, ship it."\n\n## Editing\n- Change little.\n')
  const a = app('Initech')
  ai.reply = { letter: 'I once spent a week inside a report nobody read.\n\nTim' }
  const r = await writeCoverLetter(a.id, { notes: 'Mention the reports.' })
  expect(r.written).toBe(true)
  const md = getApplication(a.id)!.packageMd!
  expect(md).toContain('## Cover letter\nI once spent a week inside a report nobody read.\n\nTim\n\n## Uploads')
  expect(md).toContain('Because I like the way your team')
  expect(md).not.toContain(DRAFT)
  expect(ai.prompts[0]).toContain('"Screw it, ship it."')
  expect(ai.prompts[0]).toContain(DRAFT)
  expect(ai.prompts[0]).toContain('Mention the reports.')
  expect(ai.opts[0]).not.toHaveProperty('mcp')
})

test('a figure that is in none of the facts gets reported', async () => {
  const a = app('Initrode')
  ai.reply = { letter: 'I cut our bill by 73% in a week.' }
  expect((await writeCoverLetter(a.id)).unsure).toEqual(['73'])
})

test('no letter asked for, or a revision that left the letter alone, calls no AI', async () => {
  const none = app('Globex', 'Not requested by this form.')
  expect((await writeCoverLetter(none.id)).written).toBe(false)
  const kept = app('Hooli')
  expect((await writeCoverLetter(kept.id, { before: pkg(DRAFT) })).written).toBe(false)
  expect(ai.prompts).toEqual([])
})

test('a failed or empty reply leaves the draft in place', async () => {
  const a = app('Umbrella')
  ai.fail = true
  await expect(writeCoverLetter(a.id)).rejects.toThrow('no AI')
  ai.fail = false
  await expect(writeCoverLetter(a.id)).rejects.toThrow('no letter')
  expect(getApplication(a.id)!.packageMd).toContain(DRAFT)
})

test('another voice returns text with its style in the prompt and saves nothing', async () => {
  const a = app('Vehement')
  ai.reply = { letter: 'gm. i once spent a week inside a report nobody read.' }
  const r = await restyleCoverLetter(a.id, 'milady', 'What is in the box right now.')
  expect(r.text).toContain('gm.')
  expect(ai.prompts[0]).toContain('Style for this letter: milady')
  expect(ai.prompts[0]).toContain('What is in the box right now.')
  expect(getApplication(a.id)!.packageMd).toContain(DRAFT)
})

test("their own voice has no style laid over it, and an empty box falls back to the package's letter", async () => {
  const a = app('Massive Dynamic')
  ai.reply = { letter: 'Plain again.' }
  await restyleCoverLetter(a.id, 'mine', '  ')
  expect(ai.prompts[0]).not.toContain('Style for this letter')
  expect(ai.prompts[0]).toContain(DRAFT)
})
