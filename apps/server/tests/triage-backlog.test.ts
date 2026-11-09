import { describe, expect, test } from 'vitest'
import { db, schema } from '../src/db/client'
import { newId } from '../src/ids'
import { listPostings, triageBacklog } from '../src/queries'
import { updateSettings } from '../src/settings'

const now = new Date().toISOString()
const posting = (title: string, o: { triageStatus: 'pending' | 'done' | 'skipped'; closedAt?: string }) =>
  db.insert(schema.postings)
    .values({ id: newId('job_'), key: newId('k_'), title, companyName: 'Acme', firstSeenAt: now, lastSeenAt: now, triageStatus: o.triageStatus, closedAt: o.closedAt ?? null, ...(o.triageStatus === 'done' ? { decision: 'queue', fitScore: 80 } : {}) })
    .run()

describe('triage backlog', () => {
  test('counts open unscored postings only, lists them, and says whether scoring is on', () => {
    posting('Waiting', { triageStatus: 'pending' })
    posting('Closed while waiting', { triageStatus: 'pending', closedAt: now })
    posting('Scored', { triageStatus: 'done' })
    posting('Filtered out', { triageStatus: 'skipped' })

    expect(triageBacklog().waiting).toBe(1)
    expect(listPostings({ decision: 'pending' }).map((p) => p.title)).toEqual(['Waiting'])

    updateSettings('triage', { enabled: false })
    expect(triageBacklog().state).toBe('off')
    updateSettings('triage', { enabled: true })
    expect(triageBacklog().state).not.toBe('off')
  })
})
