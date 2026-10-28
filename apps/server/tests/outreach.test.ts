import { eq } from 'drizzle-orm'
import { describe, expect, test } from 'vitest'
import { db, schema } from '../src/db/client'
import { atomic } from '../src/db/tx'
import { addDays, nowIso, today } from '../src/ids'
import { createApplication, setStage } from '../src/services/applications'
import { createDraft, discardDraft, getPerson, logInteraction, markDraftSent, scheduleFollowup, updateDraft, upsertPerson } from '../src/services/people'

const app = () => createApplication({ companyName: 'Ramp', role: 'TLM' })
const person = (name = 'Hamid Dadkhah') => upsertPerson({ name, companyName: 'Ramp', title: 'Head of Engineering' })
const interactionsFor = (personId: string) => db.select().from(schema.interactions).where(eq(schema.interactions.personId, personId)).all()
const draft = (id: string) => db.select().from(schema.drafts).where(eq(schema.drafts.id, id)).get()!

describe('I sent it', () => {
  test('marks the person contacted, logs history and schedules the follow-up', () => {
    const a = app()
    const p = person()
    expect(p.stage).toBe('not-contacted')
    const d = createDraft({ personId: p.id, applicationId: a.id, channel: 'linkedin', body: 'Hi Hamid' })

    markDraftSent(d.id)

    const after = getPerson(p.id)!
    expect(after.stage).toBe('contacted')
    expect(after.lastContactAt).toBeTruthy()
    expect(after.nextContactAt).toBe(addDays(after.lastContactAt!, 7))
    expect(draft(d.id).status).toBe('sent')
    expect(interactionsFor(p.id)).toMatchObject([{ direction: 'out', channel: 'linkedin', applicationId: a.id }])
  })

  test('clicking it twice records one touchpoint', () => {
    const p = person('Twice Clicked')
    const d = createDraft({ personId: p.id, channel: 'email', body: 'Hello' })
    markDraftSent(d.id)
    markDraftSent(d.id)
    expect(interactionsFor(p.id)).toHaveLength(1)
  })

  test('a sent message can no longer be edited', () => {
    const p = person('Already Sent')
    const d = createDraft({ personId: p.id, channel: 'email', body: 'v1' })
    markDraftSent(d.id)
    expect(() => updateDraft(d.id, { body: 'v2' })).toThrow(/already sent/)
    expect(draft(d.id).body).toBe('v1')
  })

  test('a draft reassigned to someone else updates that person when sent', () => {
    const hamid = person('Hamid Reassign')
    const rahul = person('Rahul Reassign')
    const d = createDraft({ personId: hamid.id, channel: 'linkedin', body: 'Hi' })
    updateDraft(d.id, { personId: rahul.id })
    markDraftSent(d.id)
    expect(getPerson(rahul.id)!.stage).toBe('contacted')
    expect(getPerson(hamid.id)!.stage).toBe('not-contacted')
  })
})

describe('touchpoints', () => {
  test('a reply moves them to replied and puts the follow-up on today', () => {
    const p = person('Replier')
    logInteraction({ personId: p.id, channel: 'email', direction: 'out', summary: 'intro' })
    logInteraction({ personId: p.id, channel: 'email', direction: 'in', summary: 'sure, Thursday' })
    const after = getPerson(p.id)!
    expect(after.stage).toBe('replied')
    expect(after.nextContactAt).toBe(today())
  })

  test('a note changes neither stage nor last contact', () => {
    const p = person('Noted')
    logInteraction({ personId: p.id, channel: 'other', direction: 'note', summary: 'met at a meetup' })
    const after = getPerson(p.id)!
    expect(after.stage).toBe('not-contacted')
    expect(after.lastContactAt).toBeNull()
  })

  test('discarding a draft does not touch the person', () => {
    const p = person('Discarded')
    const d = createDraft({ personId: p.id, body: 'nah' })
    discardDraft(d.id)
    expect(draft(d.id).status).toBe('discarded')
    expect(getPerson(p.id)!.stage).toBe('not-contacted')
  })
})

describe('follow-ups and stages', () => {
  test('scheduleFollowup sets the person and the application together', () => {
    const a = app()
    const p = person('Scheduled')
    scheduleFollowup({ personId: p.id, applicationId: a.id, date: '2026-11-03', action: 'Ping about loop' })
    expect(getPerson(p.id)).toMatchObject({ nextContactAt: '2026-11-03', nextAction: 'Ping about loop' })
    const row = db.select().from(schema.applications).where(eq(schema.applications.id, a.id)).get()!
    expect(row).toMatchObject({ nextActionDate: '2026-11-03', nextAction: 'Ping about loop' })
  })

  test('applied sets status, applied date and a follow-up', () => {
    const a = app()
    const next = setStage(a.id, 'applied')!
    expect(next.status).toBe('active')
    expect(next.appliedAt).toBeTruthy()
    expect(next.nextActionDate).toBe(addDays(nowIso(), 7))
  })
})

describe('atomic', () => {
  test('a failing command leaves nothing behind', () => {
    const before = db.select().from(schema.people).all().length
    const boom = atomic(() => {
      upsertPerson({ name: 'Half Written', companyName: 'Nowhere' })
      throw new Error('boom')
    })
    expect(boom).toThrow('boom')
    expect(db.select().from(schema.people).all()).toHaveLength(before)
  })

  test('nested commands roll back with the outer one', () => {
    const p = person('Nested')
    const d = createDraft({ personId: p.id, body: 'x' })
    const failAfterSend = atomic(() => {
      markDraftSent(d.id)
      throw new Error('later step failed')
    })
    expect(failAfterSend).toThrow()
    expect(draft(d.id).status).toBe('draft')
    expect(getPerson(p.id)!.stage).toBe('not-contacted')
    expect(interactionsFor(p.id)).toHaveLength(0)
  })
})
