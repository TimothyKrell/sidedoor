import { eq } from 'drizzle-orm'
import { expect, test } from 'vitest'
import { db, schema } from '../src/db/client'
import { patternsOf } from '../src/services/email-finder'
import { createDraft, getPerson, markDraftSent, markEmailBounced, upsertPerson } from '../src/services/people'

const company = (name: string) => db.select().from(schema.companies).where(eq(schema.companies.name, name)).get()!

test('patternsOf reads the pattern back out of an address', () => {
  expect(patternsOf('randall@workos.com', 'Randall Tombaugh')).toEqual(['{first}'])
  expect(patternsOf('nick.nisi@workos.com', 'Nick Nisi')).toEqual(['{first}.{last}'])
  expect(patternsOf('someone@workos.com', 'Nick Nisi')).toEqual([])
})

test('a bounced guess is remembered, its pattern ruled out, and the email queued to resend', () => {
  const p = upsertPerson({ name: 'Randall Tombaugh', companyName: 'WorkOS', email: 'randall@workos.com', emailConfidence: 'guessed', emailSource: 'common pattern {first}' })
  const d = createDraft({ personId: p.id, channel: 'email', toEmail: 'randall@workos.com', subject: 'Dashboard EM', body: 'Hi Randall' })
  markDraftSent(d.id)
  expect(getPerson(p.id)!.stage).toBe('contacted')

  const r = markEmailBounced(p.id, 'randall@workos.com')

  const after = getPerson(p.id)!
  expect(after.email).toBeNull()
  expect(after.bouncedEmails).toEqual(['randall@workos.com'])
  expect(after.stage).toBe('not-contacted')
  expect(after.nextContactAt).toBeNull()
  expect(company('WorkOS').badEmailPatterns).toEqual(['{first}'])
  const resend = db.select().from(schema.drafts).where(eq(schema.drafts.id, r.resendDraftId!)).get()!
  expect(resend).toMatchObject({ status: 'draft', subject: 'Dashboard EM', body: 'Hi Randall', toEmail: null })

  // Research running again can't put the bad address back.
  upsertPerson({ name: 'Randall Tombaugh', companyName: 'WorkOS', email: 'randall@workos.com', emailConfidence: 'guessed' })
  expect(getPerson(p.id)!.email).toBeNull()
})

test('a bounce on an old address leaves the current one alone', () => {
  const p = upsertPerson({ name: 'Alon Levi', companyName: 'WorkOS', email: 'alon.levi@workos.com', emailConfidence: 'guessed' })
  const r = markEmailBounced(p.id, 'alon@workos.com')
  expect(r.current).toBe('alon.levi@workos.com')
  expect(getPerson(p.id)).toMatchObject({ email: 'alon.levi@workos.com', bouncedEmails: ['alon@workos.com'] })
})
