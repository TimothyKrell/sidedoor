import { useQuery, useQueryClient, useSuspenseQuery } from '@tanstack/react-query'
import { createFileRoute, Link } from '@tanstack/react-router'
import { ArrowRight, Check, ChevronDown, Circle, Loader2, RefreshCw } from 'lucide-react'
import { type ReactNode, useState } from 'react'
import { toast } from 'sonner'
import { STAGE_META, STAGES } from '@sidedoor/shared/format'
import { CompanyAvatar, Empty, Section, TimeAgo } from '~/components/app/bits'
import { AppRow, PersonRow, PostingCard } from '~/components/app/cards'
import { useChat } from '~/components/app/chat'
import { Button } from '~/components/ui/button'
import { qo, rpc, runScoutNowFn } from '~/lib/api'
import { useAction } from '~/lib/use-action'
import { cn } from '~/lib/utils'

export const Route = createFileRoute('/')({
  loader: ({ context }) => context.queryClient.ensureQueryData(qo.today()),
  component: Today,
})

const greeting = (name: string) => {
  const h = new Date().getHours()
  const part = h < 5 ? 'Late night' : h < 12 ? 'Morning' : h < 18 ? 'Afternoon' : 'Evening'
  return name ? `${part}, ${name}` : `Good ${part.toLowerCase()}`
}

/** Follow-ups more overdue than this are stale: shown folded, and can be cleared in one go. */
const STALE_DAYS = 21
const daysOverdue = (date: string | null | undefined, today: string) => (date ? Math.round((Date.parse(today) - Date.parse(date.slice(0, 10))) / 86400_000) : 0)

type Data = Awaited<ReturnType<typeof rpc.today>>
interface Step {
  key: string
  kind: string
  title: ReactNode
  detail?: ReactNode
  to: string
  params?: Record<string, string>
  cta: string
  avatar?: string
}

/** Most urgent kind first: work that's done and waiting on you, then people, then new things. */
const PRIORITY = ['Ready to submit', 'They replied', 'Follow up', 'Review', 'Draft to send', 'Strong new match']

/**
 * The few things worth doing now. Kinds take turns in priority order (submit, a reply, the most
 * overdue follow-up, a review...), so a pile of one kind never hides the rest.
 */
const plan = (d: Data): Step[] => {
  const byKind = new Map<string, Step[]>()
  const steps = { push: (x: Step) => byKind.set(x.kind, [...(byKind.get(x.kind) ?? []), x]) }
  for (const a of d.review.filter((x) => x.stage === 'approved'))
    steps.push({ key: `s${a.id}`, kind: 'Ready to submit', title: `${a.companyName} · ${a.role}`, detail: 'Approved. Have your AI fill the form, then submit it.', to: '/applications/$id', params: { id: a.id }, cta: 'Submit', avatar: a.companyName })
  for (const a of d.review.filter((x) => x.stage === 'review'))
    steps.push({ key: `r${a.id}`, kind: 'Review', title: `${a.companyName} · ${a.role}`, detail: 'Tailored resume and answers are ready for you to check.', to: '/applications/$id', params: { id: a.id }, cta: 'Review', avatar: a.companyName })
  const replied = d.duePeople.filter((p) => p.stage === 'replied' && daysOverdue(p.nextContactAt, d.today) <= STALE_DAYS)
  for (const p of replied)
    steps.push({ key: `p${p.id}`, kind: 'They replied', title: p.name, detail: p.nextAction ?? `${p.title ?? ''}${p.companyName ? ` · ${p.companyName}` : ''}`, to: '/people/$id', params: { id: p.id }, cta: 'Reply', avatar: p.companyName ?? p.name })
  for (const { draft, personName } of d.drafts.slice(0, 3))
    steps.push({ key: `d${draft.id}`, kind: 'Draft to send', title: personName ?? draft.toEmail ?? 'Draft', detail: draft.subject ?? draft.body, to: draft.personId ? '/people/$id' : '/people', params: draft.personId ? { id: draft.personId } : {}, cta: 'Send', avatar: personName ?? undefined })
  // People and applications to follow up on, most overdue first.
  const followups = [
    ...d.duePeople
      .filter((x) => x.stage !== 'replied' && daysOverdue(x.nextContactAt, d.today) <= STALE_DAYS)
      .map((p) => ({ date: p.nextContactAt ?? '', step: { key: `f${p.id}`, kind: 'Follow up', title: p.name, detail: p.nextAction ?? p.companyName ?? '', to: '/people/$id', params: { id: p.id }, cta: 'Follow up', avatar: p.companyName ?? p.name } })),
    ...d.dueApps
      .filter((a) => daysOverdue(a.nextActionDate, d.today) <= STALE_DAYS)
      .map((a) => ({ date: a.nextActionDate ?? '', step: { key: `a${a.id}`, kind: 'Follow up', title: `${a.companyName} · ${a.role}`, detail: a.nextAction ?? '', to: '/applications/$id', params: { id: a.id }, cta: 'Open', avatar: a.companyName } })),
  ].sort((x, y) => x.date.localeCompare(y.date))
  for (const f of followups) steps.push(f.step)
  for (const p of d.fresh.slice(0, 2))
    steps.push({ key: `j${p.id}`, kind: 'Strong new match', title: `${p.title}`, detail: `${p.companyName ?? ''}${p.summary ? ` · ${p.summary}` : ''}`, to: '/jobs/$id', params: { id: p.id }, cta: 'Look', avatar: p.companyName ?? undefined })
  const queues = PRIORITY.map((k) => byKind.get(k) ?? [])
  const out: Step[] = []
  for (let round = 0; queues.some((q) => q.length > round); round++) for (const q of queues) if (q[round]) out.push(q[round]!)
  return out
}

function Today() {
  const { data } = useSuspenseQuery(qo.today())
  const { data: settings } = useQuery(qo.settings())
  const qc = useQueryClient()
  const first = settings?.settings.you.name.split(/\s+/)[0] ?? ''
  const chat = useChat()
  const scout = useAction(() => runScoutNowFn(), { success: 'Checking every source now' })
  const [showStale, setShowStale] = useState(false)
  const [showAll, setShowAll] = useState(false)
  const steps = plan(data)
  const shown = showAll ? steps : steps.slice(0, 7)
  // Anything already in Up next isn't repeated below it.
  // A draft step points at its person but isn't their follow-up, so it doesn't count.
  const inPlan = new Set(shown.filter((s) => s.kind !== 'Draft to send').map((s) => s.params?.id).filter(Boolean))
  const fresh = data.fresh.filter((p) => !inPlan.has(p.id))
  const activeStages = STAGES.filter((s) => s !== 'closed' && (data.pipeline[s] ?? 0) > 0)
  const due = (date: string | null | undefined) => daysOverdue(date, data.today)
  const stalePeople = data.duePeople.filter((p) => due(p.nextContactAt) > STALE_DAYS)
  const staleApps = data.dueApps.filter((a) => due(a.nextActionDate) > STALE_DAYS)
  const freshApps = data.dueApps.filter((a) => due(a.nextActionDate) <= STALE_DAYS && !inPlan.has(a.id))
  const freshPeople = data.duePeople.filter((p) => due(p.nextContactAt) <= STALE_DAYS && !inPlan.has(p.id))
  const staleInterested = staleApps.filter((a) => a.stage === 'interested').length
  const stale = stalePeople.length + staleApps.length
  const newInstall = data.setup.applications === 0 && (data.setup.triaged < 20 || !data.setup.experienceWritten || !data.setup.aiConnected)

  const clearStale = async () => {
    const r = await rpc.clearStaleFollowups({ days: STALE_DAYS })
    await qc.invalidateQueries({ queryKey: ['today'] })
    const parts = [r.archived && `Archived ${r.archived} untouched job${r.archived === 1 ? '' : 's'}`, r.cleared && `cleared ${r.cleared} old follow-up date${r.cleared === 1 ? '' : 's'}`].filter(Boolean).join(', ')
    toast.success(parts.charAt(0).toUpperCase() + parts.slice(1), {
      duration: 10_000,
      action: {
        label: 'Undo',
        onClick: () => void rpc.undoClearStale(r.undo).then(() => qc.invalidateQueries({ queryKey: ['today'] })),
      },
    })
  }

  return (
    <div className="space-y-8">
      <header className="flex flex-col gap-3 sm:flex-row sm:items-end">
        <div className="min-w-0 flex-1">
          <h1 className="text-2xl font-semibold tracking-tight">{greeting(first)}</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            {shown.length ? `${Math.min(steps.length, 7)} thing${Math.min(steps.length, 7) === 1 ? '' : 's'} worth doing first.` : 'Nothing needs you right now. The scout is watching.'}{' '}
            {data.status.lastScan?.at && (
              <>
                Last checked <TimeAgo iso={data.status.lastScan.at} />.
              </>
            )}
          </p>
        </div>
        <div className="flex gap-2">
          <Button variant="ghost" size="sm" onClick={() => void scout.run(undefined)} disabled={scout.pending}>
            <RefreshCw className={cn(scout.pending && 'animate-spin')} /> Check now
          </Button>
          <Button variant="outline" size="sm" onClick={() => chat.openChat({ send: 'What should I focus on today? Keep it to the top three.', newThread: true })}>
            Ask your AI
          </Button>
        </div>
      </header>

      {newInstall && <GettingStarted setup={data.setup} />}

      {shown.length > 0 && (
        <Section title="Up next">
          <ol className="divide-y overflow-hidden rounded-xl border bg-card">
            {shown.map((s, i) => (
              <li key={s.key}>
                <Link to={s.to} params={s.params as never} className="group flex items-center gap-3 px-4 py-3 transition-colors hover:bg-accent/40">
                  {s.avatar ? <CompanyAvatar name={s.avatar} /> : <span className="size-8" />}
                  <div className="min-w-0 flex-1">
                    <div className="text-xs font-medium text-muted-foreground">{s.kind}</div>
                    <div className="line-clamp-2 text-sm font-medium">{s.title}</div>
                    {s.detail && <div className="truncate text-xs text-muted-foreground">{s.detail}</div>}
                  </div>
                  <span className={cn('inline-flex h-8 shrink-0 items-center gap-1 rounded-md px-3 text-sm font-medium transition-colors', i === 0 ? 'bg-primary text-primary-foreground' : 'border bg-background group-hover:border-foreground/25')}>
                    {s.cta} <ArrowRight className="size-3.5" />
                  </span>
                </Link>
              </li>
            ))}
          </ol>
          {steps.length > 7 && (
            <button type="button" onClick={() => setShowAll(!showAll)} className="mt-2 inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground">
              {showAll ? 'Show fewer' : `${steps.length - shown.length} more waiting`} <ChevronDown className={cn('size-3 transition-transform', showAll && 'rotate-180')} />
            </button>
          )}
        </Section>
      )}

      {activeStages.length > 0 && (
        <Link to="/pipeline" className="flex flex-wrap gap-x-5 gap-y-1 text-sm text-muted-foreground hover:text-foreground">
          {activeStages.map((s) => (
            <span key={s}>
              <span className="font-semibold text-foreground tabular-nums">{data.pipeline[s]}</span> {STAGE_META[s].short.toLowerCase()}
            </span>
          ))}
          <span className="inline-flex items-center gap-1">
            Pipeline <ArrowRight className="size-3.5" />
          </span>
        </Link>
      )}

      <div className="grid grid-cols-1 gap-8 lg:grid-cols-[minmax(0,1.2fr)_minmax(0,1fr)]">
        <Section
          title="New matches"
          count={fresh.length}
          action={
            <Link to="/jobs" className="text-xs text-muted-foreground hover:text-foreground">
              All jobs
            </Link>
          }
        >
          {fresh.length ? (
            <div className="space-y-2">
              {fresh.slice(0, 6).map((p) => (
                <PostingCard key={p.id} p={p} />
              ))}
            </div>
          ) : (
            <Empty>{data.fresh.length ? 'The best new matches are in Up next.' : `No strong new matches in the last three days. ${data.newToday ? `${data.newToday} new postings came in; none fit what you want.` : ''}`}</Empty>
          )}
        </Section>

        <div className="space-y-8">
          <Section title="Follow-ups" count={freshPeople.length + freshApps.length}>
            {freshPeople.length + freshApps.length > 0 ? (
              <div className="space-y-2">
                {freshPeople.map((p) => (
                  <PersonRow key={p.id} p={p} />
                ))}
                {freshApps.map((a) => (
                  <AppRow key={a.id} a={a} />
                ))}
              </div>
            ) : (
              <Empty>{inPlan.size && data.duePeople.length + data.dueApps.length > stale ? 'The ones due now are in Up next.' : 'No follow-ups due.'}</Empty>
            )}
            {stale > 0 && (
              <div className="mt-3 rounded-xl border border-dashed">
                <div className="flex flex-wrap items-center gap-x-2 gap-y-1 px-4 py-2 text-sm text-muted-foreground">
                  <button type="button" onClick={() => setShowStale(!showStale)} aria-expanded={showStale} className="flex min-w-0 flex-1 basis-40 items-center gap-2 text-left whitespace-nowrap hover:text-foreground">
                    <ChevronDown className={cn('size-4 shrink-0 transition-transform', !showStale && '-rotate-90')} />
                    {stale} older than {STALE_DAYS} days
                  </button>
                  <Button size="sm" variant="ghost" className="h-7 shrink-0" onClick={() => void clearStale()}>
                    {staleInterested === stale ? `Archive ${stale} untouched` : staleInterested ? 'Archive untouched, clear the rest' : 'Clear these dates'}
                  </Button>
                </div>
                {showStale && (
                  <div className="space-y-2 px-3 pb-3">
                    {stalePeople.map((p) => (
                      <PersonRow key={p.id} p={p} />
                    ))}
                    {staleApps.map((a) => (
                      <AppRow key={a.id} a={a} />
                    ))}
                  </div>
                )}
              </div>
            )}
          </Section>

          {data.preparing.length > 0 && (
            <Section title="Your AI is working on" count={data.preparing.length}>
              <div className="space-y-1.5">
                {data.preparing.map((a) => (
                  <Link key={a.id} to="/applications/$id" params={{ id: a.id }} className="flex items-center gap-2 rounded-lg px-1 py-1 text-sm text-muted-foreground hover:text-foreground">
                    <Loader2 className="size-3.5 animate-spin" /> {a.companyName} · {a.role}
                  </Link>
                ))}
              </div>
            </Section>
          )}

          <details className="group">
            <summary className="flex cursor-pointer list-none items-center gap-2 text-sm font-semibold">
              <ChevronDown className="size-4 -rotate-90 text-muted-foreground transition-transform group-open:rotate-0" /> Recent activity
            </summary>
            <div className="mt-3 divide-y rounded-xl border bg-card">
              {data.activity.length ? (
                data.activity.slice(0, 12).map((a) => {
                  const body = (
                    <>
                      <div className="min-w-0 flex-1">
                        <div className="truncate">{a.title}</div>
                        {a.detail && <div className="line-clamp-1 text-xs text-muted-foreground">{a.detail}</div>}
                      </div>
                      <TimeAgo iso={a.at} className="shrink-0 text-xs text-muted-foreground" />
                    </>
                  )
                  return a.link ? (
                    <Link key={a.id} to={a.link} className="flex gap-3 px-4 py-2.5 text-sm hover:bg-accent/40">
                      {body}
                    </Link>
                  ) : (
                    <div key={a.id} className="flex gap-3 px-4 py-2.5 text-sm">
                      {body}
                    </div>
                  )
                })
              ) : (
                <div className="p-4 text-sm text-muted-foreground">Nothing yet.</div>
              )}
            </div>
          </details>
        </div>
      </div>
    </div>
  )
}

/** First days: what's happening, and the two things that make every score better. */
function GettingStarted({ setup }: { setup: Data['setup'] }) {
  const items: Array<{ done: boolean; working?: boolean; title: string; detail: string; to?: string; params?: Record<string, string>; search?: Record<string, string>; cta?: string }> = [
    {
      done: setup.aiConnected,
      title: 'Connect your AI',
      detail: 'Scoring, packages and drafts run on Claude, Codex, Grok or OpenCode, on your own subscription.',
      to: '/settings',
      search: { section: 'ai' },
      cta: 'Connect',
    },
    {
      done: setup.postings > 0,
      working: setup.sources > 0 && setup.postings === 0,
      title: setup.postings ? `Found ${setup.postings.toLocaleString()} postings on ${setup.sources} sources` : setup.sources ? `Checking ${setup.sources} job source${setup.sources === 1 ? '' : 's'}` : 'Pick where to look for jobs',
      detail: setup.postings ? 'The scout checks them again every few minutes.' : setup.sources ? 'The first pass takes a minute or two.' : 'Add job boards or company career pages for the scout to watch.',
      ...(setup.sources ? {} : { to: '/sources', cta: 'Add sources' }),
    },
    {
      done: setup.triaged >= 20,
      working: setup.postings > 0 && setup.triaged < 20,
      title: setup.triaged ? `Scored ${setup.triaged.toLocaleString()} against what you want` : 'Scoring new postings',
      detail: 'Your AI reads each one that passes the quick filter.',
    },
    {
      done: setup.experienceWritten,
      title: 'Fill in your experience',
      detail: 'Scores, resumes and drafts only use facts from it. The more it says, the better they get.',
      to: '/profile/$key',
      params: { key: 'experience' },
      cta: 'Open',
    },
    {
      done: !!setup.resume && setup.resume.lines > 0,
      title: setup.resume ? 'Finish your resume' : 'Add your resume',
      detail: 'Your AI tailors a copy of it for every application.',
      to: setup.resume ? '/resume/$id' : '/resume',
      params: setup.resume ? { id: setup.resume.id } : {},
      cta: 'Open',
    },
  ]
  // Every score and draft depends on Experience, so while it's empty it leads.
  // Nothing works without an AI, and every score and draft depends on Experience, so those lead while missing.
  const lead = (it: (typeof items)[number]) => !it.done && (it.title === 'Connect your AI' || it.title === 'Fill in your experience')
  const ordered = [...items.filter(lead), ...items.filter((it) => !lead(it))]
  return (
    <section className="rounded-xl border bg-card p-5">
      <h2 className="font-semibold">Getting started</h2>
      <ul className="mt-3 space-y-3">
        {ordered.map((it) => (
          <li key={it.title} className="flex items-start gap-3">
            <span className="mt-0.5">{it.done ? <Check className="size-4 text-success" /> : it.working ? <Loader2 className="size-4 animate-spin text-muted-foreground" /> : <Circle className="size-4 text-muted-foreground" />}</span>
            <div className="min-w-0 flex-1">
              <div className={cn('text-sm font-medium', it.done && 'text-muted-foreground')}>{it.title}</div>
              <div className="text-xs text-muted-foreground">{it.detail}</div>
            </div>
            {!it.done && it.to && (
              <Button asChild size="sm" variant="outline" className="h-7">
                <Link to={it.to} params={it.params as never} search={it.search as never}>
                  {it.cta}
                </Link>
              </Button>
            )}
          </li>
        ))}
      </ul>
    </section>
  )
}


