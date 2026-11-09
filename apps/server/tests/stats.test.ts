import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { beforeEach, expect, test } from 'vitest'
import { db, schema } from '../src/db/client'
import { createApplication, setStage, updateApplication } from '../src/services/applications'
import { logInteraction } from '../src/services/people'
import { closeKind, getStats, reachedStages } from '../src/stats'

const hoursAgo = (h: number) => new Date(Date.now() - h * 3600_000).toISOString()
const job = (role: string) => createApplication({ companyName: 'Initech', role, stage: 'interested', status: 'potential' })
const backdate = (id: string, stage: string, at: string) => db.$client.prepare('update stage_changes set at = ? where application_id = ? and stage = ?').run(at, id, stage)

beforeEach(() => {
  db.$client.exec('delete from applications; delete from stage_changes; delete from activity; delete from interactions')
})

test('closeKind reads what happened, whoever wrote it', () => {
  expect(closeKind('Rejected')).toBe('rejected')
  expect(closeKind('Rejected by Initech (email Oct 28, 2026)')).toBe('rejected')
  // Another application's rejection isn't this one's.
  expect(closeKind('Initech 90-day reapply cooldown after Designer rejection (2026-10-30)')).toBe('passed')
  expect(closeKind('Listing closed (checked 2026-10-30)')).toBe('listing')
  expect(closeKind('Hybrid, not remote: 3 days in the office')).toBe('remote')
  expect(closeKind('Pay: flat $170K base, under the $200K rule.')).toBe('pay')
  expect(closeKind('Duplicate of app_x')).toBe('duplicate')
  expect(closeKind('Not a good fit')).toBe('passed')
  // Agents closed these with no reason and noted the rejection instead.
  expect(closeKind(null, 'Applied.\n- **2026-11-04:** Rejection email Nov 4, 9:25 AM')).toBe('rejected')
  expect(closeKind(null, '- Rejected once, reapplied\n- **2026-11-04:** Went stale')).toBe('other')
  expect(closeKind(null, null)).toBe('other')
})

test('a move put right within the hour never happened', () => {
  const at = (min: number) => new Date(Date.UTC(2026, 9, 25, 18, min)).toISOString()
  const { top, reached } = reachedStages([{ stage: 'approved', at: at(0) }, { stage: 'offer', at: at(0) }, { stage: 'applied', at: at(0) }, { stage: 'interested', at: at(1) }], 'interested')
  expect(top).toBe(2)
  expect(reached.has('offer')).toBe(false)
  // Moving on quickly, or straight to Closed, keeps the stage: that's catching up, not a mistake.
  expect(reachedStages([{ stage: 'screening', at: at(0) }, { stage: 'interviewing', at: at(1) }, { stage: 'closed', at: at(2) }], 'closed').top).toBe(5)
})

test('every stage move is recorded, wherever it came from', () => {
  const a = job('Engineer')
  setStage(a.id, 'applied')
  updateApplication(a.id, { stage: 'interested' })
  updateApplication(a.id, { stage: 'interested', notesMd: 'same stage' })
  expect(db.select().from(schema.stageChanges).all().map((c) => c.stage)).toEqual(['interested', 'applied', 'interested'])
})

test('migration 0012 rebuilds stage history from the activity log', () => {
  const a = job('Engineer')
  db.$client.exec(`delete from stage_changes; drop table stage_changes`)
  db.$client.prepare(`insert into activity (id, kind, title, link, at) values ('x1', 'application', 'Initech – Engineer: Closed', ?, '2026-10-30T12:00:00.000Z'), ('x2', 'application', 'Tracking Initech', ?, '2026-10-30T12:00:00.000Z')`).run(`/applications/${a.id}`, `/applications/${a.id}`)
  db.$client.exec(readFileSync(resolve(import.meta.dirname, '../drizzle/0012_magical_blink.sql'), 'utf8'))
  expect(db.select().from(schema.stageChanges).all()).toEqual([{ id: 'stg_x1', applicationId: a.id, stage: 'closed', at: '2026-10-30T12:00:00.000Z' }])
})

test('counts submissions, rejections and how far things got, by when they happened', () => {
  const old = job('Old')
  setStage(old.id, 'applied')
  updateApplication(old.id, { appliedAt: hoursAgo(24 * 20) })
  const no = job('Rejected')
  setStage(no.id, 'applied')
  updateApplication(no.id, { appliedAt: hoursAgo(24 * 10) })
  setStage(no.id, 'closed', { closedReason: 'Rejected' })
  const screen = job('Screen')
  setStage(screen.id, 'applied')
  setStage(screen.id, 'screening')
  // A click through the stages leaves appliedAt behind; moved back, it wasn't sent.
  const mistake = job('Mistake')
  setStage(mistake.id, 'applied')
  setStage(mistake.id, 'interested')
  // Closed before it went in: not a submission, not a rejection.
  const passed = job('Passed')
  setStage(passed.id, 'closed', { closedReason: 'Not remote' })
  // A recruiter's role: no form, but they're talking.
  const recruiter = job('Recruiter')
  setStage(recruiter.id, 'interviewing')

  const all = getStats('all')
  expect(all.tiles.submitted.now).toBe(4)
  expect(all.tiles.rejected.now).toBe(1)
  expect(all.tiles.waiting).toBe(1)
  expect(all.tiles.quiet).toBe(1)
  expect(all.funnel).toEqual({ submitted: 4, heard: 3, talked: 2, interviewed: 1, offers: 0 })
  expect(all.outcomes).toMatchObject({ talking: 2, quiet: 1, rejected: 1, waiting: 0 })
  expect(all.noForm).toBe(1)
  expect(all.closed.map((c) => [c.kind, c.n]).sort()).toEqual([['rejected', 1], ['remote', 1]])

  const week = getStats('7d')
  expect(week.tiles.submitted).toEqual({ now: 2, prev: 1 })
  // Rejected today, for an application sent ten days ago: it's this week's rejection.
  expect(week.tiles.rejected).toEqual({ now: 1, prev: 0 })
  expect(week.series.reduce((n, b) => n + b.submitted, 0)).toBe(2)
  expect(week.series).toHaveLength(7)
})

test('a logged call or meeting is an interview, whatever stage the application was left in', () => {
  // Screened by a recruiter, then withdrawn, without ever being moved to Screening.
  const screened = job('Screened')
  logInteraction({ applicationId: screened.id, channel: 'meeting', direction: 'note', summary: 'Recruiter screen booked for tomorrow', at: hoursAgo(48) })
  logInteraction({ applicationId: screened.id, channel: 'call', direction: 'note', summary: 'Recruiter screen with Erin', at: hoursAgo(24) })
  setStage(screened.id, 'closed', { closedReason: 'Commute too long for a non-remote role' })
  // Booked but not had yet: talking, not interviewed.
  const booked = job('Booked')
  setStage(booked.id, 'screening')
  logInteraction({ applicationId: booked.id, channel: 'meeting', direction: 'note', summary: 'Interview scheduled for Friday', at: hoursAgo(1) })
  // The only stage-based interview.
  const loop = job('Loop')
  setStage(loop.id, 'interviewing')

  const all = getStats('all')
  expect(all.funnel).toMatchObject({ submitted: 3, talked: 3, interviewed: 2 })
  expect(all.tiles.talked.now).toBe(3)
})

test('a bare day counts on that local day, whatever the time zone', () => {
  const a = job('Dated')
  setStage(a.id, 'applied')
  const now = new Date(2026, 10, 6, 23, 0)
  updateApplication(a.id, { appliedAt: '2026-11-06' })
  const s = getStats('7d', now)
  expect(s.series.at(-1)).toMatchObject({ at: '2026-11-06', submitted: 1 })
})

test('with nothing to show, it still answers', () => {
  const s = getStats('24h')
  expect(s.hasData).toBe(false)
  expect(s.series).toHaveLength(24)
  expect(s.records).toEqual([])
  expect(s.tiles.responseRate.now).toBeNull()
})
