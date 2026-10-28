import { and, desc, eq, like, ne, or, sql } from 'drizzle-orm'
import { logActivity } from '../activity'
import { ensureCompany } from '../companies'
import { db, schema } from '../db/client'
import { atomic } from '../db/tx'
import { addDays, newId, nowIso } from '../ids'
import { getSettings } from '../settings'
import { updateApplication } from './applications'
import { xUrl } from '@sidedoor/shared/x'
import { patternsOf } from './email-finder'

export type PersonInput = Partial<Omit<typeof schema.people.$inferInsert, 'id' | 'createdAt'>> & { name: string }

export const getPerson = (id: string) => db.select().from(schema.people).where(eq(schema.people.id, id)).get()

/** Create or update a person, matching on email, LinkedIn URL, X handle, or name+company. */
export const upsertPerson = atomic((input: PersonInput, o: { applicationId?: string; role?: string } = {}) => {
  const companyId = input.companyId ?? (input.companyName ? ensureCompany(input.companyName).id : null)
  const linkedin = input.linkedin?.replace(/\/$/, '') ?? null
  const x = input.x === undefined ? undefined : xUrl(input.x)
  const matches = [
    input.email ? eq(schema.people.email, input.email) : undefined,
    linkedin ? like(schema.people.linkedin, `${linkedin}%`) : undefined,
    x ? sql`lower(${schema.people.x}) = ${x.toLowerCase()}` : undefined,
    companyId ? and(eq(schema.people.name, input.name), eq(schema.people.companyId, companyId)) : eq(schema.people.name, input.name),
  ].filter((c) => c !== undefined)
  const existing = db.select().from(schema.people).where(or(...matches)).get()
  let id: string
  if (existing) {
    id = existing.id
    const patch: Record<string, unknown> = {}
    for (const [k, v] of Object.entries({ ...input, companyId, linkedin, ...(x !== undefined ? { x } : {}) })) {
      if (v === undefined || v === null || v === '') continue
      if ((k === 'email' || k === 'emailConfidence' || k === 'emailSource') && input.email && existing.bouncedEmails?.includes(input.email.toLowerCase())) continue
      // Don't let a guessed email overwrite a better one.
      if (k === 'email' && existing.email && existing.emailConfidence !== 'guessed' && input.emailConfidence === 'guessed') continue
      if (k === 'emailConfidence' && existing.email && existing.emailConfidence !== 'guessed' && v === 'guessed') continue
      patch[k] = v
    }
    db.update(schema.people).set({ ...patch, updatedAt: nowIso() }).where(eq(schema.people.id, id)).run()
  } else {
    id = newId('per_')
    db.insert(schema.people).values({ ...input, id, companyId, linkedin, ...(x !== undefined ? { x } : {}) }).run()
    logActivity('person', `Added ${input.name}${input.companyName ? ` (${input.companyName})` : ''}`, { detail: input.title ?? undefined, link: `/people/${id}` })
  }
  if (o.applicationId) linkPerson(o.applicationId, id, o.role)
  return getPerson(id)!
})

export const linkPerson = (applicationId: string, personId: string, role?: string) =>
  db.insert(schema.applicationPeople)
    .values({ applicationId, personId, role: role ?? null })
    .onConflictDoUpdate({ target: [schema.applicationPeople.applicationId, schema.applicationPeople.personId], set: { role: role ?? null } })
    .run()

/** Record a touchpoint. Outbound contact schedules the next follow-up automatically. */
export const logInteraction = atomic((v: {
  personId?: string | null
  applicationId?: string | null
  channel: string
  direction: 'out' | 'in' | 'note'
  summary: string
  at?: string
  nextContactInDays?: number | null
}) => {
  const at = v.at ?? nowIso()
  db.insert(schema.interactions)
    .values({ id: newId('int_'), personId: v.personId ?? null, applicationId: v.applicationId ?? null, channel: v.channel, direction: v.direction, summary: v.summary, at })
    .run()
  if (v.personId) {
    const p = getPerson(v.personId)
    if (p) {
      const cadence = v.nextContactInDays ?? p.cadenceDays ?? getSettings().followups.defaultCadenceDays
      const patch: Partial<schema.Person> = { updatedAt: nowIso() }
      if (v.direction !== 'note') patch.lastContactAt = at
      if (v.direction === 'out') {
        if (p.stage === 'not-contacted') patch.stage = 'contacted'
        patch.nextContactAt = cadence ? addDays(at, cadence) : null
      }
      if (v.direction === 'in') {
        patch.stage = p.stage === 'engaged' ? 'engaged' : 'replied'
        // They replied: the ball is in the user's court today.
        patch.nextContactAt = addDays(at, 0)
      }
      db.update(schema.people).set(patch).where(eq(schema.people.id, p.id)).run()
      logActivity('outreach', `${v.direction === 'in' ? 'Heard from' : v.direction === 'out' ? 'Reached out to' : 'Note on'} ${p.name}`, { detail: v.summary, link: `/people/${p.id}` })
    }
  }
  if (v.applicationId) db.update(schema.applications).set({ lastActivityAt: at }).where(eq(schema.applications.id, v.applicationId)).run()
})

export const createDraft = atomic((v: { personId?: string | null; applicationId?: string | null; channel?: string; toEmail?: string | null; subject?: string | null; body: string; author?: 'agent' | 'user' }) => {
  const id = newId('dft_')
  db.insert(schema.drafts)
    .values({ id, personId: v.personId ?? null, applicationId: v.applicationId ?? null, channel: v.channel ?? 'email', toEmail: v.toEmail ?? null, subject: v.subject ?? null, body: v.body, author: v.author ?? 'agent' })
    .run()
  return db.select().from(schema.drafts).where(eq(schema.drafts.id, id)).get()!
})

/** The user sent a draft (from Gmail/LinkedIn). Logs the touchpoint and schedules the follow-up. */
export const markDraftSent = atomic((id: string, nextContactInDays?: number) => {
  const d = db.select().from(schema.drafts).where(eq(schema.drafts.id, id)).get()
  if (!d) throw new Error(`No draft ${id}`)
  if (d.status === 'sent') return
  db.update(schema.drafts).set({ status: 'sent', sentAt: nowIso() }).where(eq(schema.drafts.id, id)).run()
  logInteraction({
    personId: d.personId,
    applicationId: d.applicationId,
    channel: d.channel,
    direction: 'out',
    summary: d.subject ? `Sent: ${d.subject}` : `Sent ${d.channel} message`,
    nextContactInDays: nextContactInDays ?? null,
  })
})

/**
 * A touchpoint was logged by mistake. Removes it and, when it was the latest contact, rolls the
 * person's last contact, follow-up date and stage back to what the remaining history implies.
 */
export const deleteInteraction = atomic((id: string) => {
  const row = db.select().from(schema.interactions).where(eq(schema.interactions.id, id)).get()
  if (!row) throw new Error(`No interaction ${id}`)
  db.delete(schema.interactions).where(eq(schema.interactions.id, id)).run()
  const p = row.personId ? getPerson(row.personId) : undefined
  if (!p || row.direction === 'note' || p.lastContactAt !== row.at) return
  const last = db
    .select()
    .from(schema.interactions)
    .where(and(eq(schema.interactions.personId, p.id), ne(schema.interactions.direction, 'note')))
    .orderBy(desc(schema.interactions.at))
    .get()
  const contacted = db.select({ id: schema.interactions.id }).from(schema.interactions).where(and(eq(schema.interactions.personId, p.id), eq(schema.interactions.direction, 'out'))).get()
  const cadence = p.cadenceDays ?? getSettings().followups.defaultCadenceDays
  db.update(schema.people)
    .set({
      lastContactAt: last?.at ?? null,
      nextContactAt: !last ? null : last.direction === 'in' ? addDays(last.at, 0) : cadence ? addDays(last.at, cadence) : null,
      ...(!contacted && p.stage === 'contacted' ? { stage: 'not-contacted' as const } : {}),
      updatedAt: nowIso(),
    })
    .where(eq(schema.people.id, p.id))
    .run()
})

/** The user marked a draft sent but didn't send it: back to a draft, and the "Sent" touchpoint and its follow-up are undone. */
export const reopenDraft = atomic((id: string) => {
  const d = db.select().from(schema.drafts).where(eq(schema.drafts.id, id)).get()
  if (!d) throw new Error(`No draft ${id}`)
  if (d.status === 'draft') return
  db.update(schema.drafts).set({ status: 'draft', sentAt: null }).where(eq(schema.drafts.id, id)).run()
  if (d.status !== 'sent' || !d.personId || !d.sentAt) return
  // The touchpoint markDraftSent logged: same person and channel, outbound, at the moment it was marked.
  const summary = d.subject ? `Sent: ${d.subject}` : `Sent ${d.channel} message`
  const sentMs = new Date(d.sentAt).getTime()
  const logged = db
    .select()
    .from(schema.interactions)
    .where(and(eq(schema.interactions.personId, d.personId), eq(schema.interactions.direction, 'out'), eq(schema.interactions.channel, d.channel), eq(schema.interactions.summary, summary)))
    .all()
    .filter((i) => Math.abs(new Date(i.at).getTime() - sentMs) < 120_000)
    .sort((a, b) => Math.abs(new Date(a.at).getTime() - sentMs) - Math.abs(new Date(b.at).getTime() - sentMs))[0]
  if (logged) deleteInteraction(logged.id)
})

export const unlinkPerson = atomic((applicationId: string, personId: string) => {
  db.delete(schema.applicationPeople).where(and(eq(schema.applicationPeople.applicationId, applicationId), eq(schema.applicationPeople.personId, personId))).run()
})

export type PersonPatch = Partial<Omit<typeof schema.people.$inferInsert, 'id' | 'createdAt'>>

/** The user edited a contact by hand. A company name change re-links the company. */
export const updatePerson = atomic((id: string, patch: PersonPatch) => {
  const companyId = patch.companyName ? ensureCompany(patch.companyName).id : undefined
  const x = patch.x === undefined ? {} : { x: xUrl(patch.x) }
  db.update(schema.people).set({ ...patch, ...x, ...(companyId ? { companyId } : {}), updatedAt: nowIso() }).where(eq(schema.people.id, id)).run()
  return getPerson(id)
})

/** When to follow up next (and what to do) for a person and/or an application. `date: null` clears it. */
export const scheduleFollowup = atomic((v: { personId?: string | null; applicationId?: string | null; date: string | null; action?: string | null }) => {
  const action = v.action !== undefined ? { nextAction: v.action } : {}
  if (v.personId) db.update(schema.people).set({ nextContactAt: v.date, ...action, updatedAt: nowIso() }).where(eq(schema.people.id, v.personId)).run()
  if (v.applicationId) updateApplication(v.applicationId, { nextActionDate: v.date, ...action })
})

export type DraftPatch = Partial<Pick<typeof schema.drafts.$inferInsert, 'body' | 'subject' | 'toEmail' | 'personId' | 'originalBody' | 'editorChanges' | 'editedAt' | 'editorError'>>

/** Edit a draft's text/recipient (the user's edits, or the editor pass). Sent drafts are history and can't change. */
export const updateDraft = atomic((id: string, patch: DraftPatch) => {
  const d = db.select().from(schema.drafts).where(eq(schema.drafts.id, id)).get()
  if (!d) throw new Error(`No draft ${id}`)
  if (d.status === 'sent' && (patch.body !== undefined || patch.personId !== undefined)) throw new Error('This message was already sent')
  db.update(schema.drafts).set(patch).where(eq(schema.drafts.id, id)).run()
})

export const discardDraft = atomic((id: string) => {
  db.update(schema.drafts).set({ status: 'discarded' }).where(eq(schema.drafts.id, id)).run()
})

/** Gmail compose link that works on desktop and opens the Gmail app on phones. */
export const gmailComposeUrl = (to: string | null, subject: string | null, body: string) => {
  const q = new URLSearchParams({ view: 'cm', fs: '1', ...(to ? { to } : {}), ...(subject ? { su: subject } : {}), body })
  return `https://mail.google.com/mail/?${q.toString()}`
}

/**
 * The user got a delivery failure. The address is wrong, so: remember it (never suggest it again), rank
 * the format it came from last for the company when it was a guess, clear it, note the bounce,
 * undo the follow-up the send scheduled, and put a copy of the bounced message back in drafts so it
 * can go out again once there's a better address. Returns what's needed to look for the next one.
 */
export const markEmailBounced = atomic((personId: string, address?: string | null) => {
  const p = getPerson(personId)
  if (!p) throw new Error(`No person ${personId}`)
  const email = (address || p.email || '').toLowerCase()
  if (!email) throw new Error('No email on file for this person')
  if (p.email?.toLowerCase() !== email) {
    // An older address bounced; the one on file now is different, so just remember the bad one.
    db.update(schema.people).set({ bouncedEmails: [...new Set([...(p.bouncedEmails ?? []), email])], updatedAt: nowIso() }).where(eq(schema.people.id, p.id)).run()
    return { personId: p.id, name: p.name, companyId: p.companyId, domain: email.split('@')[1]!, bounced: email, resendDraftId: null, current: p.email }
  }
  const guessed = p.emailConfidence === 'guessed' || p.emailConfidence === 'pattern'
  const company = p.companyId ? db.select().from(schema.companies).where(eq(schema.companies.id, p.companyId)).get() : undefined
  const patterns = guessed ? patternsOf(email, p.name) : []
  if (company && patterns.length) {
    const bad = [...new Set([...(company.badEmailPatterns ?? []), ...patterns])]
    db.update(schema.companies)
      .set({ badEmailPatterns: bad, ...(company.emailPattern && patterns.includes(company.emailPattern) ? { emailPattern: null } : {}), updatedAt: nowIso() })
      .where(eq(schema.companies.id, company.id))
      .run()
  }
  const outbound = db.select().from(schema.interactions).where(and(eq(schema.interactions.personId, p.id), eq(schema.interactions.direction, 'out'))).all()
  // If email was the only way we reached them, they haven't really been contacted.
  const onlyEmail = outbound.every((i) => i.channel === 'email')
  db.update(schema.people)
    .set({
      email: null,
      emailConfidence: null,
      emailSource: `${email} bounced ${nowIso().slice(0, 10)}`,
      bouncedEmails: [...new Set([...(p.bouncedEmails ?? []), email])],
      ...(onlyEmail && p.stage === 'contacted' ? { stage: 'not-contacted' as const, nextContactAt: null, lastContactAt: null } : {}),
      updatedAt: nowIso(),
    })
    .where(eq(schema.people.id, p.id))
    .run()
  db.insert(schema.interactions)
    .values({ id: newId('int_'), personId: p.id, applicationId: null, channel: 'email', direction: 'note', summary: `Email to ${email} bounced; it never arrived.`, at: nowIso() })
    .run()
  const sent = db.select().from(schema.drafts).where(and(eq(schema.drafts.personId, p.id), eq(schema.drafts.status, 'sent'), eq(schema.drafts.channel, 'email'))).all()
    .filter((d) => !d.toEmail || d.toEmail.toLowerCase() === email)
    .sort((a, b) => (b.sentAt ?? '').localeCompare(a.sentAt ?? ''))[0]
  const resend = sent ? createDraft({ personId: p.id, applicationId: sent.applicationId, channel: 'email', toEmail: null, subject: sent.subject, body: sent.body, author: sent.author === 'user' ? 'user' : 'agent' }) : null
  logActivity('outreach', `Email to ${p.name} bounced`, { detail: email, link: `/people/${p.id}` })
  return { personId: p.id, name: p.name, companyId: p.companyId, domain: company?.domain ?? email.split('@')[1]!, bounced: email, resendDraftId: resend?.id ?? null, current: null }
})

/** Save the next address to try after a bounce, and point the resend draft at it. */
export const setRetryEmail = atomic((v: { personId: string; email: string; confidence: string; source: string; draftId: string | null }) => {
  db.update(schema.people).set({ email: v.email, emailConfidence: v.confidence, emailSource: v.source, updatedAt: nowIso() }).where(eq(schema.people.id, v.personId)).run()
  if (v.draftId) db.update(schema.drafts).set({ toEmail: v.email }).where(eq(schema.drafts.id, v.draftId)).run()
})
