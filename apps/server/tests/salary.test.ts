import { describe, expect, test } from 'vitest'
import { salaryRange } from '@sidedoor/shared/format'

describe('salary range', () => {
  test('reads the first range out of board and Claude compensation text', () => {
    expect(salaryRange('$215K – $250K • Offers Equity • Offers Bonus')).toBe('$215K–$250K')
    expect(salaryRange('$131,064 – $184,800 • Offers Equity')).toBe('$131K–$185K')
    expect(salaryRange('CA$250K – CA$535K • Offers Equity')).toBe('CA$250K–CA$535K')
    expect(salaryRange('$200,000-$255,000 U.S. average or $220,000-$275,000 NYC, plus equity')).toBe('$200K–$255K')
    expect(salaryRange('$158,440–$198,050 USD base (GEO1) plus token')).toBe('$158K–$198K')
    expect(salaryRange('$150-200K base')).toBe('$150K–$200K')
    expect(salaryRange('$190.5K • Offers Equity')).toBe('$191K')
    expect(salaryRange('$85 - $110/hr')).toBe('$85–$110/hr')
    expect(salaryRange('CAD 186,500 - 223,500 (Canada listing)')).toBe('CAD 187K–224K')
    expect(salaryRange('$0 – $252K • Offers Equity')).toBe('up to $252K')
    expect(salaryRange('{"min": 150000, "max": 180000, "currency": "USD", "interval": "per-year-salary"}')).toBe('$150K–$180K')
  })

  test('no figure means nothing to show; min/max fill in when the text has none', () => {
    expect(salaryRange('Not published')).toBeNull()
    expect(salaryRange(null)).toBeNull()
    expect(salaryRange('$0-$0')).toBeNull()
    expect(salaryRange('Competitive', 180000, 220000)).toBe('$180K–$220K')
    // The board's max is sometimes wrong; the text wins.
    expect(salaryRange('$216K – $329.4K', 216000, 216000)).toBe('$216K–$329K')
  })
})
