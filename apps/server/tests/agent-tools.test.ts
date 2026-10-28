import { eq } from 'drizzle-orm'
import { describe, expect, test } from 'vitest'
import { db, schema } from '../src/db/client'
import { addDays } from '../src/ids'
import { createApplication, getApplication, mergeApplications } from '../src/services/applications'
import { createDraft, deleteInteraction, getPerson, linkPerson, logInteraction, markDraftSent, reopenDraft, upsertPerson } from '../src/services/people'

const draft = (id: string) => db.select().from(schema.drafts).where(eq(schema.drafts.id, id)).get()!
const interactionsFor = (personId: string) => db.select().from(schema.interactions).where(eq(schema.interactions.personId, personId)).all()

describe('I marked it sent by mistake', () => {
  test('the draft is sendable again and the touchpoint and follow-up are undone', () => {
    const p = upsertPerson({ name: 'Michael Greer', companyName: 'Render' })
    const d = createDraft({ personId: p.id, channel: 'email', subject: 'Billing EM role', body: 'Hi Michael' })
    markDraftSent(d.id)
    expect(getPerson(p.id)!.stage).toBe('contacted')

    reopenDraft(d.id)

    expect(draft(d.id)).toMatchObject({ status: 'draft', sentAt: null })
    expect(interactionsFor(p.id)).toEqual([])
    expect(getPerson(p.id)).toMatchObject({ stage: 'not-contacted', lastContactAt: null, nextContactAt: null })
  })

  test('earlier history survives: the follow-up goes back to the previous touchpoint', () => {
    const p = upsertPerson({ name: 'Earlier Contact', companyName: 'Render' })
    const earlier = '2026-10-01T15:00:00.000Z'
    logInteraction({ personId: p.id, channel: 'linkedin', direction: 'out', summary: 'Connected', at: earlier })
    const d = createDraft({ personId: p.id, channel: 'email', subject: 'Follow-up', body: 'Hi again' })
    markDraftSent(d.id)

    reopenDraft(d.id)

    expect(interactionsFor(p.id)).toMatchObject([{ summary: 'Connected' }])
    expect(getPerson(p.id)).toMatchObject({ stage: 'contacted', lastContactAt: earlier, nextContactAt: addDays(earlier, 7) })
  })

  test('a discarded draft can come back too', () => {
    const d = createDraft({ channel: 'email', body: 'Keep me' })
    db.update(schema.drafts).set({ status: 'discarded' }).where(eq(schema.drafts.id, d.id)).run()
    reopenDraft(d.id)
    expect(draft(d.id).status).toBe('draft')
  })
})

describe('deleting a touchpoint', () => {
  test('an older touchpoint goes without touching the current follow-up', () => {
    const p = upsertPerson({ name: 'Two Touches', companyName: 'Ashby' })
    logInteraction({ personId: p.id, channel: 'email', direction: 'out', summary: 'First', at: '2026-10-01T12:00:00.000Z' })
    logInteraction({ personId: p.id, channel: 'email', direction: 'out', summary: 'Second', at: '2026-10-10T12:00:00.000Z' })
    const before = getPerson(p.id)!
    const first = interactionsFor(p.id).find((i) => i.summary === 'First')!
    deleteInteraction(first.id)
    expect(getPerson(p.id)).toMatchObject({ lastContactAt: before.lastContactAt, nextContactAt: before.nextContactAt })
  })

  test('removing a reply puts the follow-up back on the cadence from the last outreach', () => {
    const p = upsertPerson({ name: 'Wrong Reply', companyName: 'Ashby' })
    const out = '2026-10-01T12:00:00.000Z'
    logInteraction({ personId: p.id, channel: 'email', direction: 'out', summary: 'Hello', at: out })
    logInteraction({ personId: p.id, channel: 'email', direction: 'in', summary: 'Not actually them', at: '2026-10-03T12:00:00.000Z' })
    deleteInteraction(interactionsFor(p.id).find((i) => i.direction === 'in')!.id)
    expect(getPerson(p.id)).toMatchObject({ lastContactAt: out, nextContactAt: addDays(out, 7) })
  })
})

describe('merging duplicate applications', () => {
  test('people, touchpoints, drafts and research move to the kept one; the duplicate closes', () => {
    const keep = createApplication({ companyName: 'Ashby', role: 'Engineering Manager – Americas', jobUrl: 'https://jobicy.com/jobs/151638' })
    const dup = createApplication({ companyName: 'Ashby', role: 'Engineering Manager - Americas', jobUrl: 'https://jobs.ashbyhq.com/ashby/695b', location: 'Remote - US', compText: '$200K – $300K', notesMd: 'Imported from the vault' })
    const p = upsertPerson({ name: 'Abhik Pramanik', companyName: 'Ashby' })
    const shared = upsertPerson({ name: 'Ben Asher', companyName: 'Ashby' })
    linkPerson(dup.id, p.id, 'hiring-manager')
    linkPerson(dup.id, shared.id, 'team-member')
    linkPerson(keep.id, shared.id, 'interviewer')
    logInteraction({ personId: p.id, applicationId: dup.id, channel: 'email', direction: 'note', summary: 'Found via GitHub' })
    const d = createDraft({ personId: p.id, applicationId: dup.id, channel: 'email', body: 'Hi Abhik' })
    db.insert(schema.research).values({ id: 'res_dup', applicationId: dup.id, title: 'Ashby brief', bodyMd: '...' }).run()

    const merged = mergeApplications(keep.id, dup.id)

    const links = db.select().from(schema.applicationPeople).where(eq(schema.applicationPeople.applicationId, keep.id)).all()
    expect(links.map((l) => [l.personId, l.role]).sort()).toEqual([[p.id, 'hiring-manager'], [shared.id, 'interviewer']].sort())
    expect(db.select().from(schema.applicationPeople).where(eq(schema.applicationPeople.applicationId, dup.id)).all()).toEqual([])
    expect(interactionsFor(p.id)[0]!.applicationId).toBe(keep.id)
    expect(draft(d.id).applicationId).toBe(keep.id)
    expect(db.select().from(schema.research).where(eq(schema.research.id, 'res_dup')).get()!.applicationId).toBe(keep.id)
    // The kept one's own link wins; blanks fill from the duplicate.
    expect(merged).toMatchObject({ jobUrl: 'https://jobicy.com/jobs/151638', location: 'Remote - US', compText: '$200K – $300K' })
    expect(merged.notesMd).toContain('Imported from the vault')
    expect(getApplication(dup.id)).toMatchObject({ stage: 'closed', status: 'closed-lost', closedReason: `Duplicate of ${keep.id}` })
  })

  test('an application cannot be merged into itself', () => {
    const a = createApplication({ companyName: 'Solo', role: 'EM' })
    expect(() => mergeApplications(a.id, a.id)).toThrow()
  })
})
