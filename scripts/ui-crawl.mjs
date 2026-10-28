#!/usr/bin/env node
/**
 * Open every page of a running Sidedoor in headless Chromium, report console errors and page
 * crashes, and save a screenshot of each to the output folder.
 *   node scripts/ui-crawl.mjs <base-url> <pairing-token> [out-dir] [--mobile] [--dark]
 */
import { mkdirSync } from 'node:fs'
import { createRequire } from 'node:module'
import { resolve } from 'node:path'

const require = createRequire(resolve(import.meta.dirname, '../apps/server/package.json'))
const { chromium } = require('playwright-core')
const [base, token, out = '/tmp/sidedoor-crawl'] = process.argv.slice(2).filter((a) => !a.startsWith('--'))
const mobile = process.argv.includes('--mobile')
const dark = process.argv.includes('--dark')
mkdirSync(out, { recursive: true })

const exe = ['/usr/bin/chromium', '/usr/bin/chromium-browser', '/usr/bin/google-chrome'].find((p) => require('node:fs').existsSync(p))
const browser = await chromium.launch({ executablePath: exe, headless: true })
const ctx = await browser.newContext({ viewport: mobile ? { width: 390, height: 844 } : { width: 1440, height: 900 }, colorScheme: dark ? 'dark' : 'light', deviceScaleFactor: 1 })
const page = await ctx.newPage()
const problems = []
page.on('console', (m) => m.type() === 'error' && problems.push(`[console] ${page.url()} ${m.text().slice(0, 300)}`))
page.on('pageerror', (e) => problems.push(`[crash] ${page.url()} ${e.message.slice(0, 300)}`))
page.on('response', (r) => r.status() >= 500 && problems.push(`[${r.status()}] ${r.url()}`))
await page.goto(`${base}/pair#token=${token}`)
await page.waitForURL((u) => !u.pathname.startsWith('/pair'), { timeout: 15000 })

const api = async (name, body = {}) => (await page.evaluate(async ([n, b]) => (await (await fetch(`/api/rpc/${n}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(b) })).json()).data, [name, body]))
const appData = await api('applications')
const apps = [...(appData?.open ?? []), ...(appData?.closed ?? [])]
const people = (await api('people', {}))?.people ?? []
const postings = (await api('postings', { window: 'all' })) ?? []
const resumes = (await api('resumes')) ?? []
const threads = (await api('threads')) ?? []
const routes = [
  '/', '/welcome', '/jobs', '/pipeline', '/people', '/resume', '/profile', '/profile/experience', '/profile/tells', '/stories', '/chat', '/radar', '/tasks', '/sources',
  ...['you', 'search', 'ai', 'notifications', 'devices', 'integrations', 'appearance', 'about'].map((s) => `/settings?section=${s}`),
  ...apps.slice(0, 3).map((a) => `/applications/${a.id}`),
  ...people.slice(0, 2).map((p) => `/people/${p.id}`),
  ...(Array.isArray(postings) ? postings : []).slice(0, 2).map((p) => `/jobs/${p.id}`),
  ...resumes.slice(0, 2).map((r) => `/resume/${r.id}`),
  ...threads.slice(0, 1).map((t) => `/chat/${t.id}`),
]
for (const r of routes) {
  const before = problems.length
  await page.goto(`${base}${r}`, { waitUntil: 'networkidle', timeout: 30000 }).catch((e) => problems.push(`[nav] ${r} ${e.message}`))
  await page.waitForTimeout(600)
  const name = r.replace(/[^a-z0-9]+/gi, '_').replace(/^_|_$/g, '') || 'today'
  await page.screenshot({ path: resolve(out, `${name}${mobile ? '.mobile' : ''}${dark ? '.dark' : ''}.png`), fullPage: false })
  console.log(`${problems.length > before ? '✗' : '✓'} ${r}`)
}
await browser.close()
if (problems.length) {
  console.log(`\n${problems.length} problems:`)
  for (const p of [...new Set(problems)]) console.log(p)
  process.exit(1)
}
console.log('\nno problems')
