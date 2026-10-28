import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { expect, test } from 'vitest'

/**
 * People, applications, drafts and touchpoints must change only through the service commands in
 * src/services/. Those commands keep the related records in step (a sent draft marks the
 * person contacted, schedules the follow-up, logs history) and run atomically. A direct
 * db.update(schema.people) elsewhere skips all of that.
 */
const DOMAIN = /\.(insert|update|delete)\(\s*schema\.(people|interactions|drafts|applications|applicationPeople)\b/
const ALLOWED = ['src/services/']

const files = (dir: string): string[] =>
  readdirSync(dir).flatMap((f) => {
    const p = join(dir, f)
    return statSync(p).isDirectory() ? files(p) : /\.(ts|tsx)$/.test(f) ? [p] : []
  })

test('domain tables are only written by service commands', () => {
  const root = process.cwd()
  const offenders = files(join(root, 'src'))
    .map((f) => relative(root, f))
    .filter((f) => !ALLOWED.some((a) => f.startsWith(a)))
    .flatMap((f) =>
      readFileSync(join(root, f), 'utf8')
        .split('\n')
        .map((line, i) => ({ f, line: i + 1, text: line.trim() }))
        .filter((l) => DOMAIN.test(l.text)),
    )
    .map((o) => `${o.f}:${o.line}  ${o.text.slice(0, 100)}`)
  expect(offenders, 'Use a command from src/services/ instead').toEqual([])
})
