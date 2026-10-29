import { expect, test } from 'vitest'
import { createApplication, getApplication, rankApplications, setShot, setStage, unrankApplications } from '../src/services/applications'

const app = (companyName: string, stage: 'interested' | 'review' = 'review') => createApplication({ companyName, role: 'Engineer', stage, status: 'potential' }).id

test('ranking puts the named applications first, in order, and keeps the rest of the ranked ones after them', () => {
  const [a, b, c, d] = ['Ranka', 'Rankb', 'Rankc', 'Rankd'].map((n) => app(n))
  rankApplications([a!, b!, c!])
  rankApplications([c!, d!])
  expect([c, d, a, b].map((id) => getApplication(id!)?.rank)).toEqual([1, 2, 3, 4])
  unrankApplications([d!])
  expect(getApplication(d!)?.rank).toBeNull()
  expect(() => rankApplications(['app_missing'])).toThrow(/No application/)
})

test('moving to another stage drops the rank; staying in the stage keeps it', () => {
  const id = app('Movee')
  rankApplications([id])
  setStage(id, 'review')
  expect(getApplication(id)?.rank).toBe(1)
  setStage(id, 'approved')
  expect(getApplication(id)?.rank).toBeNull()
})

test('a ranking or an odds estimate is not activity on the application', () => {
  const id = app('Quiet', 'interested')
  const before = getApplication(id)!.lastActivityAt
  rankApplications([id])
  setShot(id, 140, 'Strong match')
  const after = getApplication(id)!
  expect(after.lastActivityAt).toBe(before)
  expect(after.shot).toBe(100)
  expect(after.shotWhy).toBe('Strong match')
})
