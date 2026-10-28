import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { eq } from 'drizzle-orm'
import type { ResumeContent, ResumeNote } from '@sidedoor/shared/resume'
import { paths } from '../config'
import { db, schema } from '../db/client'
import { nowIso } from '../ids'
import { setSecret } from '../secrets'
import { setResumeMatch, updateApplication } from '../services/applications'
import { setDoc } from '../services/documents'
import { createResume } from '../services/resumes'
import { getSettings, saveSettings } from '../settings'
import { parseLegacyResume } from './resume-html'

/**
 * One-time move from a pre-1.0 Sidedoor checkout (its data/sidedoor.sqlite) and the resume
 * workspace it read (~/Code/resume) into this app's home. Copies, never moves: the old install
 * keeps working until you switch it off.
 */

const expand = (p: string) => (p.startsWith('~/') ? resolve(homedir(), p.slice(2)) : resolve(p))
const read = (p: string) => (existsSync(p) ? readFileSync(p, 'utf8') : '')
const stripFrontmatter = (s: string) => s.replace(/^---\n[\s\S]*?\n---\n?/, '')
const log = (s: string) => console.log(`[import] ${s}`)

/** Tables copied column by column (only columns both schemas have). */
const TABLES = ['companies', 'sources', 'postings', 'applications', 'people', 'application_people', 'interactions', 'drafts', 'research', 'tasks', 'activity', 'notifications', 'chat_threads', 'chat_messages'] as const

const columns = (d: DatabaseSync, table: string) => (d.prepare(`pragma table_info(${table})`).all() as Array<{ name: string }>).map((c) => c.name)

type OldSettings = {
  scout?: Record<string, unknown>
  triage?: { model?: string } & Record<string, unknown>
  prep?: { model?: string; auto?: boolean; maxAwaitingReview?: number }
  research?: { model?: string; auto?: boolean }
  funding?: { model?: string; enabled?: boolean; intervalHours?: number }
  discover?: { model?: string; enabled?: boolean; hour?: number }
  notify?: Record<string, unknown> & { ntfyTopic?: string; ntfyToken?: string }
  followups?: { defaultCadenceDays?: number; afterApplyDays?: number }
  integrations?: { hunterApiKey?: string }
  chat?: { model?: string }
  editor?: { enabled?: boolean; model?: string }
  worker?: { concurrency?: number; paused?: boolean }
}

export const importLegacy = async (o: { from: string; resumeDir: string | null; force?: boolean }) => {
  const from = expand(o.from)
  const resumeDir = expand(o.resumeDir ?? '~/Code/resume')
  const oldDbPath = resolve(from, 'data/sidedoor.sqlite')
  if (!existsSync(oldDbPath)) throw new Error(`No database at ${oldDbPath}`)
  const existing = db.select({ id: schema.applications.id }).from(schema.applications).limit(1).all()
  if (existing.length && !o.force) throw new Error('This Sidedoor already has applications. Import into a fresh home (SIDEDOOR_HOME) or pass --force.')

  const old = new DatabaseSync(oldDbPath, { readOnly: true })
  try {
    // All or nothing: a failure halfway leaves the new home as it was, so the import can be re-run.
    db.$client.transaction(() => run(old, from, resumeDir))()
  } finally {
    old.close()
  }
  log(`done. Open Sidedoor; everything is in ${paths.state}`)
}

const run = (old: DatabaseSync, from: string, resumeDir: string) => {
  const client = db.$client

  // 1. Tables ------------------------------------------------------------------------------
  const oldTables = new Set((old.prepare("select name from sqlite_master where type = 'table'").all() as Array<{ name: string }>).map((r) => r.name))
  client.transaction(() => {
    for (const t of TABLES) {
      if (!oldTables.has(t)) continue
      const keep = columns(old, t).filter((c) => columns(client.db, t).includes(c))
      const rows = old.prepare(`select ${keep.map((c) => `"${c}"`).join(', ')} from ${t}`).all() as Array<Record<string, unknown>>
      const ins = client.db.prepare(`insert or ignore into ${t} (${keep.map((c) => `"${c}"`).join(', ')}) values (${keep.map(() => '?').join(', ')})`)
      for (const r of rows) {
        if (t === 'drafts') r.author = r.author === 'tim' ? 'user' : 'agent'
        // Preparing is no longer a stage (migration 0003): the card shows prep work instead.
        if (t === 'applications' && r.stage === 'preparing') r.stage = r.package_md ? 'review' : 'interested'
        // Old jobs don't run again here; they stay as history.
        if (t === 'tasks' && (r.status === 'queued' || r.status === 'running')) r.status = 'cancelled'
        ins.run(...keep.map((c) => (r[c] ?? null) as never))
      }
      log(`${t}: ${rows.length}`)
    }
    client.db.exec("update chat_threads set provider = 'claude' where session_id is not null and provider is null")
    client.db.exec("update tasks set provider = 'claude' where provider is null and status in ('done', 'failed')")
  })()

  // 2. Settings ----------------------------------------------------------------------------
  const oldRow = old.prepare("select value from settings where key = 'app'").get() as { value?: string } | undefined
  const s = (oldRow?.value ? JSON.parse(oldRow.value) : {}) as OldSettings
  const cur = getSettings()
  const job = (model: string | undefined) => ({ provider: 'claude' as const, model: model ?? '' })
  const sc = (s.scout ?? {}) as Record<string, unknown>
  saveSettings({
    ...cur,
    onboarding: { completedAt: nowIso(), step: 'notify' },
    scout: {
      ...cur.scout,
      ...Object.fromEntries(['enabled', 'hotIntervalMin', 'normalIntervalMin', 'maxAgeDays', 'titleInclude', 'titleExclude', 'locationOk', 'remoteWords'].filter((k) => sc[k] !== undefined).map((k) => [k, sc[k]])),
      ...(typeof sc.nonUs === 'string' ? { locationBlock: sc.nonUs } : {}),
    },
    triage: { ...cur.triage, ...Object.fromEntries(Object.entries(s.triage ?? {}).filter(([k]) => k !== 'model')) },
    prep: { ...cur.prep, ...(s.prep?.auto !== undefined ? { auto: s.prep.auto } : {}), ...(s.prep?.maxAwaitingReview ? { maxAwaitingReview: s.prep.maxAwaitingReview } : {}) },
    research: { ...cur.research, ...(s.research?.auto !== undefined ? { auto: s.research.auto } : {}) },
    funding: { ...cur.funding, ...(s.funding?.enabled !== undefined ? { enabled: s.funding.enabled } : {}), ...(s.funding?.intervalHours ? { intervalHours: s.funding.intervalHours } : {}) },
    discover: { ...cur.discover, ...(s.discover?.enabled !== undefined ? { enabled: s.discover.enabled } : {}), ...(s.discover?.hour !== undefined ? { hour: s.discover.hour } : {}) },
    notify: {
      ...cur.notify,
      ...Object.fromEntries(['ntfyServer', 'ntfyTopic', 'hotFitScore', 'hotMaxAgeHours', 'digestHour', 'quietStart', 'quietEnd'].filter((k) => s.notify?.[k] !== undefined).map((k) => [k, s.notify![k]])),
      ntfyEnabled: !!s.notify?.ntfyTopic,
    },
    followups: { ...cur.followups, ...s.followups },
    editor: { ...cur.editor, ...(s.editor?.enabled !== undefined ? { enabled: s.editor.enabled } : {}) },
    worker: { ...cur.worker, ...s.worker },
    ai: {
      ...cur.ai,
      default: 'claude',
      jobs: {
        ...cur.ai.jobs,
        triage: job(s.triage?.model),
        prep: job(s.prep?.model),
        research: job(s.research?.model),
        outreach: job(s.research?.model),
        funding: job(s.funding?.model),
        discover: job(s.discover?.model),
        chat: job(s.chat?.model),
        editor: job(s.editor?.model),
      },
    },
  })
  if (s.integrations?.hunterApiKey) setSecret('hunter-api-key', s.integrations.hunterApiKey)
  if (s.notify?.ntfyToken) setSecret('ntfy-token', s.notify.ntfyToken)
  // Job bookkeeping (what funding news was seen, last runs) carries over.
  for (const r of old.prepare("select key, value from settings where key like 'meta:%'").all() as Array<{ key: string; value: string }>)
    client.db.prepare('insert or replace into settings (key, value) values (?, ?)').run(r.key, r.value)
  log('settings')

  // 3. Profile documents -------------------------------------------------------------------
  const vault = resolve(resumeDir, 'job-hunt')
  const inventory = read(resolve(resumeDir, 'career-inventory.md'))
  const bullets = read(resolve(resumeDir, 'bullet-bank.md'))
  if (inventory) setDoc('experience', bullets ? `${inventory.trimEnd()}\n\n---\n\n${bullets.replace(/^# /m, '# Bullet bank: ')}` : inventory)
  for (const [key, file, fm] of [
    ['stories', resolve(resumeDir, 'story-bank.md'), false],
    ['writing', resolve(resumeDir, 'writing-rules.md'), false],
    ['tells', resolve(resumeDir, 'tells.json'), false],
    ['search', resolve(vault, 'Pipeline/Config/Fit Criteria.md'), true],
    ['answers', resolve(vault, 'Pipeline/Config/Applicant Profile.md'), true],
  ] as const) {
    const body = read(file)
    if (body) setDoc(key, fm ? stripFrontmatter(body) : body)
  }
  log('profile documents')

  // 4. Resumes -----------------------------------------------------------------------------
  const notesOf = (dir: string): ResumeNote[] => {
    try {
      const n = JSON.parse(read(resolve(dir, 'notes.json')) || '[]') as Array<ResumeNote & { thread: Array<{ who: string }> }>
      return n.map((x) => ({ ...x, thread: x.thread.map((m) => ({ ...m, who: (m.who as string) === 'tim' || m.who === 'user' ? ('user' as const) : ('agent' as const) })) }))
    } catch {
      return []
    }
  }
  const mainDir = resolve(resumeDir, 'main-resume')
  const mainContent = parseLegacyResume(read(resolve(mainDir, 'resume.html')))
  if (!mainContent) throw new Error(`Could not read ${mainDir}/resume.html`)
  const base = parseLegacyResume(read(resolve(mainDir, '.review-base.html')))
  const main = createResume({ title: 'Main resume', content: mainContent, reviewBase: base ?? mainContent, theme: 'deco', kind: 'base' })
  db.update(schema.resumes).set({ notes: notesOf(mainDir) }).where(eq(schema.resumes.id, main.id)).run()
  const you = getSettings().you
  saveSettings({
    ...getSettings(),
    you: { ...you, name: mainContent.basics.name, email: mainContent.basics.email, phone: mainContent.basics.phone, location: mainContent.basics.location, country: you.country || 'US', links: mainContent.basics.links },
  })

  const oldApps = (old.prepare('select id, stage, resume_html, resume_pdf, match_json from applications').all() as Array<{ id: string; stage: string; resume_html: string | null; resume_pdf: string | null; match_json: string | null }>)
  const appByFolder = new Map<string, (typeof oldApps)[number]>()
  for (const a of oldApps) {
    const folder = a.resume_html?.split('/')[1]
    if (folder) appByFolder.set(folder, a)
  }
  const tailoredDir = resolve(resumeDir, 'tailored')
  let imported = 0
  let fallback = 0
  for (const folder of existsSync(tailoredDir) ? readdirSync(tailoredDir, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name) : []) {
    const dir = resolve(tailoredDir, folder)
    const files = readdirSync(dir)
    const htmlFile = files.find((f) => f.endsWith('.html') && /-resume/.test(f)) ?? files.find((f) => f.endsWith('.html') && !f.startsWith('.'))
    if (!htmlFile) continue
    let content: ResumeContent | null = parseLegacyResume(read(resolve(dir, htmlFile)))
    const parsedOk = !!content && content.sections.length > 0
    if (!parsedOk) {
      content = mainContent
      fallback++
    }
    const app = appByFolder.get(folder)
    // Tailoring you already sent counts as reviewed; packages still in review keep their pending edits.
    const sent = app && ['applied', 'screening', 'interviewing', 'offer', 'closed'].includes(app.stage)
    const reviewBase = sent ? content : parseLegacyResume(read(resolve(dir, '.review-base.html')))
    const r = createResume({ title: folder, kind: 'tailored', applicationId: app?.id ?? null, baseId: main.id, theme: 'deco', content: content!, reviewBase: parsedOk ? (reviewBase ?? content) : content })
    const pdf = files.find((f) => f === htmlFile.replace(/\.html$/, '.pdf')) ?? files.find((f) => f.endsWith('.pdf'))
    if (pdf) {
      // The PDF that was actually sent, kept as is.
      const destDir = resolve(paths.files, 'resumes', r.id)
      mkdirSync(destDir, { recursive: true })
      copyFileSync(resolve(dir, pdf), resolve(destDir, pdf))
      db.update(schema.resumes).set({ pdfFile: `resumes/${r.id}/${pdf}` }).where(eq(schema.resumes.id, r.id)).run()
    }
    db.update(schema.resumes).set({ notes: notesOf(dir) }).where(eq(schema.resumes.id, r.id)).run()
    if (app) {
      // The match result pointed at the folder name; point it at the resume now.
      const match = app.match_json ? (JSON.parse(app.match_json) as { doc?: string; resumeVersion?: string }) : null
      updateApplication(app.id, { resumeId: r.id })
      if (match) setResumeMatch(app.id, { ...match, doc: r.id, resumeVersion: String(r.version) } as never)
    }
    imported++
  }
  // Applications whose match ran against the main resume.
  for (const a of oldApps)
    if (a.match_json && !a.resume_html) {
      const m = JSON.parse(a.match_json) as Record<string, unknown>
      setResumeMatch(a.id, { ...m, doc: main.id, resumeVersion: String(main.version) } as never)
    }
  log(`resumes: main + ${imported} tailored (${fallback} in a layout Sidedoor couldn't read; they start as a copy of your main resume, with the original PDF attached)`)

  const gaps = resolve(from, 'data/agent-gaps.md')
  if (existsSync(gaps)) copyFileSync(gaps, resolve(paths.logs, 'agent-gaps.md'))
}
