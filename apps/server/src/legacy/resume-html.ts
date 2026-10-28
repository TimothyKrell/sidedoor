import { parseHTML } from 'linkedom'
import { type Company, normalizeContent, type ResumeContent, type Section } from '@sidedoor/shared/resume'

/**
 * Parse a resume made with the pre-1.0 Sidedoor HTML template (main-resume/resume.html and its
 * tailored copies) into structured content. Line ids come from the template's data-id attributes,
 * so notes, reviews and match results that point at lines keep working.
 */
const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40)
/** The element's data-id, or an id from where it sits, so two copies of a resume get the same ids. */
const idOf = (el: Element | null | undefined, fallback: string) => el?.getAttribute('data-id') || fallback

const text = (el: Element | null | undefined) => (el?.textContent ?? '').replace(/\s+/g, ' ').trim()
const inner = (el: Element | null | undefined) => (el?.innerHTML ?? '').replace(/\s+/g, ' ').trim()

export function parseLegacyResume(html: string): ResumeContent | null {
  const { document } = parseHTML(html)
  const h1 = document.querySelector('header h1')
  if (!h1) return null
  const contact = document.querySelector('header .contact')
  const links: Array<{ label: string; url: string }> = []
  let email = ''
  for (const a of contact?.querySelectorAll('a') ?? []) {
    const href = a.getAttribute('href') ?? ''
    if (href.startsWith('mailto:')) email = href.slice(7)
    else if (href) links.push({ label: /linkedin/.test(href) ? 'LinkedIn' : /github/.test(href) ? 'GitHub' : 'Website', url: href })
  }
  const contactText = (contact?.textContent ?? '').split(/[◆|·•]/).map((s) => s.trim()).filter(Boolean)
  const phone = contactText.find((s) => /^\+?[\d\s().-]{7,}$/.test(s)) ?? ''
  const location = contactText.find((s) => s !== phone && !s.includes('@') && !/\.(com|io|dev|org|net)|linkedin|github/i.test(s)) ?? ''
  const pos = document.querySelector('header [data-id]') ?? document.querySelector('header .positioning')
  let si = 0

  const sections: Section[] = []
  let lastExperience: Extract<Section, { type: 'experience' }> | null = null
  for (const sec of document.querySelectorAll('section')) {
    const title = text(sec.querySelector('h2'))
    const sid = `sec-${slug(title.replace(/,?\s*continued$/i, '')) || si}`
    si++
    const summary = sec.querySelector('.summary')
    const companies = [...sec.querySelectorAll('article.company')]
    if (summary) {
      sections.push({ id: sid, type: 'summary', title, text: { id: idOf(summary, `${sid}-text`), text: inner(summary) } })
    } else if (companies.length) {
      const parsed: Company[] = companies.map((art, ci) => {
        const nameEl = art.querySelector('.company-line [data-id]') ?? art.querySelector('.company-line > span:not(.location)')
        const cid = idOf(nameEl, `co-${slug(text(nameEl)) || `${si}-${ci}`}`)
        return {
          id: cid,
          name: inner(nameEl),
          location: text(art.querySelector('.company-line .location')),
          roles: [...art.querySelectorAll('.role')].map((r, ri) => {
            const t = r.querySelector('.role-line [data-id]') ?? r.querySelector('.role-line > span:not(.dates)')
            const rid = idOf(t, `${cid}-r${ri}`)
            return {
              id: rid,
              title: text(t),
              dates: text(r.querySelector('.dates')),
              bullets: [...r.querySelectorAll('li')].map((li, bi) => ({ id: idOf(li, `${rid}-b${bi}`), text: inner(li) })),
            }
          }),
        }
      })
      // "Professional Experience, Continued" on page two: same section, page break before it.
      if (/continued/i.test(title) && lastExperience) {
        if (parsed[0]) parsed[0].pageBreakBefore = true
        lastExperience.companies.push(...parsed)
      } else {
        lastExperience = { id: sid, type: 'experience', title, companies: parsed }
        sections.push(lastExperience)
      }
    } else if (sec.classList.contains('skills') || sec.querySelector('p > strong')) {
      sections.push({
        id: sid,
        type: 'skills',
        title,
        groups: [...(sec.querySelectorAll('[data-id]').length ? sec.querySelectorAll('[data-id]') : sec.querySelectorAll('p'))].map((p, gi) => {
          const strong = p.querySelector('strong')
          const label = text(strong).replace(/:$/, '')
          strong?.remove()
          return { id: idOf(p, `${sid}-g${gi}`), label, text: inner(p).replace(/^:\s*/, '') }
        }),
      })
    } else {
      const items = [...(sec.querySelectorAll('[data-id]').length ? sec.querySelectorAll('[data-id]') : sec.querySelectorAll('li, p'))]
      if (items.length) sections.push({ id: sid, type: 'list', title, items: items.map((el, ii) => ({ id: idOf(el, `${sid}-i${ii}`), text: inner(el) })) })
    }
  }

  return normalizeContent({
    version: 1,
    basics: { name: text(h1), headline: pos ? { id: idOf(pos, 'headline'), text: inner(pos) } : null, location, email, phone, links },
    highlights: [...document.querySelectorAll('.stat')].map((s, hi) => ({ id: idOf(s, `stat-${hi}`), value: text(s.querySelector('.stat-num')), label: text(s.querySelector('.stat-label')) })),
    sections,
  })
}
