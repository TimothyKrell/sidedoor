import { Effect } from 'effect'
import { assertPublicUrl } from '../browser/guard-net'
import { ATS_LINK, detectAts, fetchText } from '../scout/adapters'

/** Where an application goes in: a form to fill, an email address, or nowhere we know of. */
export type ApplyTarget =
  | { kind: 'form'; url: string; /** Found on the job page, not the URL the application had. */ resolved: boolean }
  | { kind: 'email'; email: string; url: string }
  | { kind: 'none'; why: string }

const decode = (s: string) => s.replace(/&amp;/g, '&').replace(/&#x2F;/gi, '/').replace(/&#47;/g, '/').replace(/&quot;/g, '"').trim()
const textOf = (html: string) => decode(html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' '))
const APPLYISH = /\bapply\b|\bapplication\b|submit (?:your )?(?:resume|cv)|bewerben|postuler/i

const absolute = (href: string, base: string) => {
  try {
    const u = new URL(decode(href), base)
    return u.protocol === 'http:' || u.protocol === 'https:' || u.protocol === 'mailto:' ? u.href : null
  } catch {
    return null
  }
}

const emailOf = (mailto: string) => decodeURIComponent(mailto.slice(7).split('?')[0] ?? '').trim()

/** The job's own ATS page behind a company careers page that embeds Greenhouse (…?gh_jid=123). */
const greenhouseEmbed = (html: string, pageUrl: string) => {
  const jid = new URL(pageUrl).searchParams.get('gh_jid') ?? html.match(/gh_jid=(\d+)/)?.[1]
  const board = html.match(/greenhouse\.io\/embed\/job_(?:board|app)(?:\/js)?\?(?:[^"'\s<>]*&(?:amp;)?)?for=([A-Za-z0-9_-]+)/)?.[1]
  return jid && board ? `https://job-boards.greenhouse.io/${board}/jobs/${jid}` : null
}

/**
 * The apply link on a job page: an ATS form link first (the job's own, then any apply link to an
 * ATS), then an "Apply" link elsewhere, then a mailto. Null when the page has none of these; the
 * page itself is then the best guess.
 */
export const applyLinkIn = (html: string, pageUrl: string): ApplyTarget | null => {
  const anchors = [...html.matchAll(/<a\b([^>]*)>([\s\S]*?)<\/a>/gi)].flatMap((m) => {
    const href = m[1]?.match(/\bhref\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i)
    const url = href ? absolute(href[1] ?? href[2] ?? href[3] ?? '', pageUrl) : null
    if (!url) return []
    const label = `${textOf(m[2] ?? '')} ${m[1]?.match(/\baria-label\s*=\s*"([^"]*)"/i)?.[1] ?? ''}`.trim()
    return [{ url, label }]
  })
  const here = pageUrl.split('#')[0]
  const isAts = (u: string) => !!detectAts(u) || [...u.matchAll(ATS_LINK)].length > 0
  const apply = (a: { url: string; label: string }) => APPLYISH.test(a.label) || /\/apply\b|\bapply[/?]|application/i.test(a.url)
  const form = (url: string): ApplyTarget => ({ kind: 'form', url, resolved: true })

  const atsApply = anchors.find((a) => a.url.startsWith('http') && isAts(a.url) && apply(a))
  if (atsApply) return form(atsApply.url)
  const embed = greenhouseEmbed(html, pageUrl)
  if (embed) return form(embed)
  const iframe = [...html.matchAll(/<iframe\b[^>]*\bsrc\s*=\s*["']([^"']+)["']/gi)].map((m) => absolute(m[1] ?? '', pageUrl)).find((u) => !!u && isAts(u))
  if (iframe) return form(iframe)
  const otherApply = anchors.find((a) => a.url.startsWith('http') && apply(a) && a.url.split('#')[0] !== here)
  if (otherApply) return form(otherApply.url)
  // An ATS job link in the page's scripts or data (single-page careers sites).
  const scripted = [...html.matchAll(ATS_LINK)].map((m) => decode(m[0]).replace(/[\\),;]+$/, '')).find((u) => /\/jobs?\/|\/apply|\/j\/|[0-9a-f]{8}-[0-9a-f]{4}/i.test(u))
  if (scripted) return form(scripted)
  const mail = anchors.find((a) => a.url.startsWith('mailto:') && (apply(a) || /job|career|recruit|talent|hiring|apply/i.test(a.url)))
  if (mail) return { kind: 'email', email: emailOf(mail.url), url: mail.url }
  return null
}

/**
 * Where to send an application. A mailto is an email application, never filled. An ATS URL is
 * used as it is. A job page (an application with only its listing's URL) is read for its apply
 * link; when it has none, or can't be read, the page itself is filled, as before.
 */
export const resolveApplyTarget = async (
  a: { applyUrl: string | null; jobUrl: string | null },
  fetchHtml: (url: string) => Promise<string> = async (url) => {
    await assertPublicUrl(url)
    return Effect.runPromise(fetchText(url, 20_000))
  },
): Promise<ApplyTarget> => {
  const url = a.applyUrl ?? a.jobUrl
  if (!url) return { kind: 'none', why: 'It has no apply URL or job page.' }
  if (url.startsWith('mailto:')) return { kind: 'email', email: emailOf(url), url }
  if (detectAts(url)) return { kind: 'form', url, resolved: false }
  // An apply URL someone set that isn't the listing itself is taken at its word.
  if (a.applyUrl && a.jobUrl && a.applyUrl !== a.jobUrl) return { kind: 'form', url, resolved: false }
  try {
    const found = applyLinkIn(await fetchHtml(url), url)
    if (found && !(found.kind === 'form' && found.url.split('#')[0] === url.split('#')[0])) return found
  } catch {
    // Unreadable here (a script-only page, a block): the form filler opens it in a real browser.
  }
  return { kind: 'form', url, resolved: false }
}
