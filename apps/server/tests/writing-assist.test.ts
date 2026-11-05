import { afterEach, describe, expect, test, vi } from 'vitest'

const ai = vi.hoisted(() => ({ reply: { text: '', gaps: [] as string[] } as unknown, prompts: [] as string[], opts: [] as Record<string, unknown>[] }))
vi.mock('../src/ai', async (orig) => ({
  ...(await orig<typeof import('../src/ai')>()),
  runJob: async (o: { prompt: string }) => {
    ai.prompts.push(o.prompt)
    ai.opts.push(o)
    return { text: '', data: ai.reply, log: [], costUsd: 0, provider: 'claude', model: 'm' }
  },
}))

const { assistWriting } = await import('../src/writing/assist')
const { createApplication, getApplication } = await import('../src/services/applications')
const { setDoc } = await import('../src/services/documents')

const PACKAGE = `# Review

## Application form

### Q1: Why this team?
[You write this]

### Q2: Tell us about a hard call
I had to shut down our own product and it was hard but right.
`
const app = (companyName: string) => createApplication({ companyName, role: 'Engineer', stage: 'review', packageMd: PACKAGE })

afterEach(() => {
  ai.prompts = []
  ai.opts = []
})

describe('cleaning up what you rambled', () => {
  test('returns the tidied text and saves nothing', async () => {
    const a = app('Tidy')
    ai.reply = { text: 'I shut down our own product. It was the right call.', gaps: [] }
    const r = await assistWriting(a.id, 'q:2', 'cleanup', 'so um I shut down our own product, it was uh the right call I think')
    expect(r).toEqual({ text: 'I shut down our own product. It was the right call.', note: null })
    expect(ai.prompts[0]).toContain('so um I shut down our own product')
    expect(ai.prompts[0]).toContain('Tell us about a hard call')
    expect(getApplication(a.id)!.packageMd).toBe(PACKAGE)
  })

  test('refuses a number you never said, leaving your text alone', async () => {
    const a = app('Numbers')
    ai.reply = { text: 'I cut costs by 40% for a team of 12.', gaps: [] }
    await expect(assistWriting(a.id, 'q:2', 'cleanup', 'I cut costs a lot for my team of 12')).rejects.toThrow(/added numbers you didn't say \(40\)/)
  })

  test('needs something in the box, and spends no AI without it', async () => {
    const a = app('Empty')
    await expect(assistWriting(a.id, 'q:1', 'cleanup', '   ')).rejects.toThrow(/Write something/)
    expect(ai.prompts).toEqual([])
  })
})

describe('drafting an answer', () => {
  test('works from your Experience, builds on your notes, and has no tools', async () => {
    setDoc('experience', '## Acme\nRan the migration to Postgres in 2023.')
    const a = app('Drafty')
    ai.reply = { text: 'I ran the migration to Postgres in 2023.', gaps: [] }
    const r = await assistWriting(a.id, 'q:1', 'draft', 'mention the migration')
    expect(r).toEqual({ text: 'I ran the migration to Postgres in 2023.', note: null })
    expect(ai.prompts[0]).toContain('Ran the migration to Postgres')
    expect(ai.prompts[0]).toContain('mention the migration')
    expect(ai.opts[0]).not.toHaveProperty('mcp')
    expect(getApplication(a.id)!.packageMd).toBe(PACKAGE)
  })

  test('says which numbers it can’t find in your facts, and what your facts did not cover', async () => {
    setDoc('experience', '## Acme\nRan the migration.')
    const a = app('Unsure')
    ai.reply = { text: 'I ran the migration for 300 customers.', gaps: ['why this team'] }
    const r = await assistWriting(a.id, 'q:1', 'draft', '')
    expect(r.note).toContain('300')
    expect(r.note).toContain('why this team')
  })

  test('a section that changed under you is an error, not a guess', async () => {
    const a = app('Gone')
    await expect(assistWriting(a.id, 'q:9', 'draft', '')).rejects.toThrow(/reload/)
  })
})
