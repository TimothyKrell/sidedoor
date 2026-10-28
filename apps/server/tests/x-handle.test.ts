import { describe, expect, test } from 'vitest'
import { xHandle, xUrl } from '@sidedoor/shared/x'
import { getPerson, updatePerson, upsertPerson } from '../src/services/people'

describe('X handles', () => {
  test('reads handles from the usual ways people write them', () => {
    for (const raw of ['@jane_doe', 'jane_doe', 'x.com/jane_doe', 'https://x.com/jane_doe', 'https://twitter.com/jane_doe/status/123', 'https://www.x.com/@jane_doe?s=20'])
      expect(xHandle(raw)).toBe('jane_doe')
    for (const raw of ['', '  ', 'https://x.com/home', 'https://example.com/jane', 'not a handle']) expect(xHandle(raw)).toBeNull()
    expect(xUrl('@jane_doe')).toBe('https://x.com/jane_doe')
  })

  test('people store the canonical profile URL and match on it', () => {
    const p = upsertPerson({ name: 'Jane Doe', companyName: 'Vercel', x: '@Jane_Doe' })
    expect(p.x).toBe('https://x.com/Jane_Doe')
    // A different name (no company) still finds the same person by handle.
    expect(upsertPerson({ name: 'Jane D.', x: 'https://twitter.com/jane_doe' }).id).toBe(p.id)

    updatePerson(p.id, { x: 'x.com/janed' })
    expect(getPerson(p.id)!.x).toBe('https://x.com/janed')
    updatePerson(p.id, { x: null })
    expect(getPerson(p.id)!.x).toBeNull()
  })
})
