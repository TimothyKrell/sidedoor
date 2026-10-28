import { bridgeFinishTab, bridgeOpenTab, bridgePdf, bridgeRead, hasBridge } from './bridge'
import { BANNER, GUARD } from './guard'
import { assertPublicUrl } from './guard-net'
import { localFormTab, localPdf, localRead } from './local'

/** Render an HTML document to PDF (letter/A4 from its own @page CSS). */
export const renderPdf = (html: string): Promise<Buffer> => (hasBridge() ? bridgePdf(html) : localPdf(html).then((b) => Buffer.from(b)))

/** Page count of a PDF, without pdfinfo: count page objects. */
export const pdfPageCount = (pdf: Buffer) => {
  const s = pdf.toString('latin1')
  const count = s.match(/\/Type\s*\/Page(?!s)\b/g)?.length ?? 0
  return count
}

const PAGE_CHARS = 40_000

export interface ReadPageResult {
  url: string
  status: number | null
  title: string
  /** Structured data the page embeds, e.g. a JobPosting with jobLocationType and applicantLocationRequirements. */
  jsonLd: unknown[]
  text: string
  offset: number
  totalChars: number
  /** Pass as `offset` to read on, when the text was cut. */
  nextOffset: number | null
}

/**
 * Load a page, let its JavaScript run, and return what a person would see. Plain fetches get an
 * empty shell from Ashby, Workday and most careers sites.
 */
export const readPage = async (url: string, offset = 0): Promise<ReadPageResult> => {
  const u = new URL(url)
  await assertPublicUrl(u.toString())
  const got = hasBridge()
    ? await bridgeRead(u.toString())
    : await localRead(u.toString(), async (page) => {
        const r = await page.evaluate(() => ({
          title: document.title,
          text: document.body?.innerText ?? '',
          jsonLd: [...document.querySelectorAll('script[type="application/ld+json"]')].map((s) => s.textContent ?? ''),
        }))
        return { ...r, url: page.url(), status: null as number | null }
      })
  const jsonLd = got.jsonLd.flatMap((s) => {
    try {
      // The description repeats the page text as HTML; drop it to save room.
      return [JSON.parse(s, (k, v: unknown) => (k === 'description' && typeof v === 'string' && v.length > 500 ? '(same as text)' : v)) as unknown]
    } catch {
      return []
    }
  })
  const full = got.text.replace(/\n{3,}/g, '\n\n').trim()
  const start = Math.max(0, Math.min(offset, full.length))
  const end = start + PAGE_CHARS
  return { url: got.url, status: got.status, title: got.title, jsonLd: start === 0 ? jsonLd : [], text: full.slice(start, end), offset: start, totalChars: full.length, nextOffset: end < full.length ? end : null }
}

export interface FormTab {
  /** For Playwright MCP to attach to. */
  cdpEndpoint: string
  /** Lift the submit guard and show the review banner. The window stays open. */
  finish: () => Promise<void>
}

/** Open an application form in its own window with the submit guard on. */
export const openFormTab = async (url: string): Promise<FormTab> => {
  if (hasBridge()) {
    const t = await bridgeOpenTab(url, GUARD)
    return { cdpEndpoint: t.cdpEndpoint, finish: () => bridgeFinishTab(t.id, BANNER) }
  }
  return localFormTab(url)
}

// One form at a time: two agents driving one browser would trip over each other.
let chain: Promise<unknown> = Promise.resolve()
export const withFormLock = <T>(fn: () => Promise<T>): Promise<T> => {
  const run = chain.then(fn, fn)
  chain = run.catch(() => {})
  return run
}
