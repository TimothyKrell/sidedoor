import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { expect, test } from 'vitest'
import { db } from '../src/db/client'
import { createApplication, getApplication } from '../src/services/applications'

test('migration 0003 moves Preparing applications to Interested, or to Review when they have a package', () => {
  const first = createApplication({ companyName: 'Initech', role: 'Engineer', stage: 'interested', status: 'potential' })
  const revising = createApplication({ companyName: 'Hooli', role: 'Engineer', stage: 'interested', status: 'potential', packageMd: '# Hooli' })
  db.$client.exec(`update applications set stage = 'preparing' where id in ('${first.id}', '${revising.id}')`)
  db.$client.exec(readFileSync(resolve(import.meta.dirname, '../drizzle/0003_no_preparing_stage.sql'), 'utf8'))
  expect(getApplication(first.id)?.stage).toBe('interested')
  expect(getApplication(revising.id)?.stage).toBe('review')
})
