import { useQuery } from '@tanstack/react-query'
import { createFileRoute, Link, useNavigate } from '@tanstack/react-router'
import type { ReactNode } from 'react'
import { z } from 'zod'
import { Empty, PageHeader } from '~/components/app/bits'
import { CalendarGrid, Columns, Legend, MirrorBars, RowBars, SplitBar } from '~/components/app/charts'
import { Segmented } from '~/components/app/segmented'
import { qo, type Stats, type StatsWindow } from '~/lib/api'
import { cn } from '~/lib/utils'

const WINDOWS: Array<{ value: StatsWindow; label: string; span: string; before: string }> = [
  { value: '24h', label: '24 hours', span: 'in the last 24 hours', before: 'the 24 hours before' },
  { value: '7d', label: '7 days', span: 'in the last 7 days', before: 'the 7 days before' },
  { value: '30d', label: '30 days', span: 'in the last 30 days', before: 'the 30 days before' },
  { value: 'all', label: 'All time', span: 'so far', before: '' },
]

export const Route = createFileRoute('/stats')({
  validateSearch: z.object({ window: z.enum(['24h', '7d', '30d', 'all']).optional().catch(undefined) }),
  loaderDeps: ({ search }) => ({ window: search.window ?? 'all' }),
  loader: ({ context, deps }) => context.queryClient.ensureQueryData(qo.stats(deps.window)),
  component: StatsPage,
})

const OUTCOMES = [
  { key: 'offer', label: 'Offer', color: 'var(--viz-offer)' },
  { key: 'talking', label: 'Talking', color: 'var(--viz-talking)' },
  { key: 'waiting', label: 'Waiting', color: 'var(--viz-waiting)' },
  { key: 'quiet', label: 'Gone quiet', color: 'var(--viz-quiet)' },
  { key: 'rejected', label: 'Rejected', color: 'var(--viz-rejected)' },
  { key: 'withdrew', label: 'You withdrew', color: 'var(--muted-foreground)' },
] as const

const CHANNEL: Record<string, string> = { linkedin: 'LinkedIn', x: 'X' }
const channel = (c: string) => CHANNEL[c] ?? c.charAt(0).toUpperCase() + c.slice(1)
const pct = (n: number | null | undefined) => (n == null ? '—' : `${Math.round(n * 100)}%`)
const usd = (n: number) => `$${n >= 100 ? Math.round(n).toLocaleString() : n.toFixed(2)}`
const inDays = (n: number | null) => (n == null ? '—' : n < 1 ? 'Under a day' : `${n} day${n === 1 ? '' : 's'}`)
const dayLabel = (key: string) => new Date(`${key}T00:00:00`).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
const bucketLabel = (at: string, unit: Stats['unit']) =>
  unit === 'hour' ? new Date(`${at}:00:00`).toLocaleTimeString(undefined, { hour: 'numeric' }) : unit === 'week' ? `Wk of ${dayLabel(at)}` : dayLabel(at)

function Panel({ title, note, children, className }: { title: ReactNode; note?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <section className={cn('min-w-0 rounded-xl border bg-card p-4', className)}>
      <h3 className="text-sm font-semibold tracking-tight">{title}</h3>
      {note && <p className="mt-0.5 text-xs text-muted-foreground">{note}</p>}
      <div className="mt-3.5">{children}</div>
    </section>
  )
}

/** A change from the period before, in plain words. Neutral: more rejections isn't a score. */
function Delta({ now, prev, before }: { now: number; prev: number | null; before: string }) {
  if (prev === null) return null
  const d = now - prev
  return <div className="mt-1 text-xs text-muted-foreground">{d === 0 ? `Same as ${before}` : `${d > 0 ? '+' : '−'}${Math.abs(d).toLocaleString()} vs ${before}`}</div>
}

function Tile({ label, value, children, hero }: { label: string; value: ReactNode; children?: ReactNode; hero?: boolean }) {
  return (
    <div className={cn('min-w-0 rounded-xl border bg-card p-4', hero && 'col-span-2')}>
      <div className="text-xs text-muted-foreground">{label}</div>
      <div className={cn('mt-1 font-semibold tracking-tight', hero ? 'text-5xl' : 'text-3xl')}>{value}</div>
      {children}
    </div>
  )
}

function Figures({ items }: { items: Array<{ label: string; value: ReactNode; note?: string }> }) {
  return (
    <dl className="grid grid-cols-2 gap-x-4 gap-y-3 sm:grid-cols-3">
      {items.map((i) => (
        <div key={i.label} className="min-w-0">
          <dt className="text-xs text-muted-foreground">{i.label}</dt>
          <dd className="text-xl font-semibold tracking-tight">{i.value}</dd>
          {i.note && <dd className="text-xs text-muted-foreground">{i.note}</dd>}
        </div>
      ))}
    </dl>
  )
}

function Funnel({ steps }: { steps: Array<{ label: string; n: number }> }) {
  const top = Math.max(1, steps[0]?.n ?? 0)
  return (
    <ol className="space-y-2">
      {steps.map((s, i) => {
        const before = steps[i - 1]?.n
        return (
          <li key={s.label}>
            <div className="mb-1 flex items-baseline justify-between gap-3 text-sm">
              <span className="min-w-0 truncate">{s.label}</span>
              <span className="shrink-0 tabular-nums">
                <span className="font-medium">{s.n.toLocaleString()}</span>
                {before ? <span className="ml-1.5 text-xs text-muted-foreground">{s.n / before < 0.01 && s.n > 0 ? '<1%' : pct(s.n / before)}</span> : null}
              </span>
            </div>
            <div className="h-2.5 rounded bg-muted">
              {s.n > 0 && <div className="h-full rounded" style={{ width: `max(4px, ${(s.n / top) * 100}%)`, background: 'var(--viz-waiting)' }} />}
            </div>
          </li>
        )
      })}
    </ol>
  )
}

/** For each group: what share got a conversation, got a no, or is still out there. */
function Fared({ rows }: { rows: Stats['fared']['fit'] }) {
  if (!rows.length) return <Empty>Nothing submitted in this period.</Empty>
  return (
    <div className="space-y-3">
      {rows.map((r) => (
        <div key={r.label}>
          <div className="mb-1 flex items-baseline justify-between gap-3 text-sm">
            <span className="min-w-0 truncate">{r.label}</span>
            <span className="shrink-0 text-xs text-muted-foreground tabular-nums">
              {r.sent} sent · {r.talked} talked · {r.rejected} no
            </span>
          </div>
          <SplitBar
            className="h-2"
            parts={[
              { label: 'Talked to someone', n: r.talked, color: 'var(--viz-talking)' },
              { label: 'No answer yet', n: r.sent - r.talked - r.rejected, color: 'var(--viz-waiting)' },
              { label: 'Rejected', n: r.rejected, color: 'var(--viz-rejected)' },
            ]}
          />
        </div>
      ))}
    </div>
  )
}

const FARED_LEGEND = [
  { label: 'Talked to someone', color: 'var(--viz-talking)' },
  { label: 'No answer yet', color: 'var(--viz-waiting)' },
  { label: 'Rejected', color: 'var(--viz-rejected)' },
]

function StatsPage() {
  const { window: w = 'all' } = Route.useSearch()
  const navigate = useNavigate({ from: '/stats' })
  const { data, isPlaceholderData } = useQuery(qo.stats(w))
  const period = WINDOWS.find((x) => x.value === w)!
  if (!data) return null
  const t = data.tiles
  const rows = data.series.map((b) => ({ key: b.at, label: bucketLabel(b.at, data.unit), up: b.submitted, down: b.rejected }))
  const outcomes = OUTCOMES.map((o) => ({ ...o, n: data.outcomes[o.key] }))
  const active = outcomes.filter((o) => o.n > 0)
  const rate = t.responseRate

  return (
    <div className="space-y-6">
      <div>
        <PageHeader title="Stats" subtitle={`${t.submitted.now.toLocaleString()} submitted and ${t.rejected.now.toLocaleString()} rejected ${period.span}.`} />
        <Segmented value={w} options={WINDOWS} onChange={(v) => void navigate({ search: { window: v }, replace: true })} />
      </div>

      {!data.hasData ? (
        <Empty>Your numbers show up here once the scout has found some jobs and you've started applying.</Empty>
      ) : (
        <div className={cn('space-y-8 transition-opacity', isPlaceholderData && 'opacity-60')}>
          <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6">
            <Tile hero label="Applications submitted" value={t.submitted.now.toLocaleString()}>
              <Delta now={t.submitted.now} prev={t.submitted.prev} before={period.before} />
              {data.noForm > 0 && <div className="mt-1 text-xs text-muted-foreground">{data.noForm} went in outside Sidedoor</div>}
            </Tile>
            <Tile label="Rejected" value={t.rejected.now.toLocaleString()}>
              <Delta now={t.rejected.now} prev={t.rejected.prev} before={period.before} />
            </Tile>
            <Tile label="Screens and interviews" value={t.talked.now.toLocaleString()}>
              <Delta now={t.talked.now} prev={t.talked.prev} before={period.before} />
            </Tile>
            <Tile label="Heard back" value={pct(rate.now)}>
              <div className="mt-1 text-xs text-muted-foreground">
                {data.funnel.heard} of {data.funnel.submitted} sent {period.span}
              </div>
            </Tile>
            <Tile label="Waiting on an answer" value={t.waiting.toLocaleString()}>
              <div className="mt-1 text-xs text-muted-foreground">Right now{t.quiet ? `, ${t.quiet} quiet for ${data.quietDays}+ days` : ''}</div>
            </Tile>
          </div>

          <Panel title="Submitted and rejected" note={data.unit === 'hour' ? 'By hour' : data.unit === 'week' ? 'By week' : 'By day'}>
            <Legend items={[{ label: 'Submitted', color: 'var(--viz-waiting)' }, { label: 'Rejected', color: 'var(--viz-rejected)' }]} />
            <div className="mt-3">
              <MirrorBars rows={rows} up={{ label: 'Submitted', color: 'var(--viz-waiting)' }} down={{ label: 'Rejected', color: 'var(--viz-rejected)' }} />
            </div>
            <details className="mt-2 text-xs text-muted-foreground">
              <summary className="cursor-pointer select-none">Show the numbers</summary>
              <table className="mt-2 w-full max-w-sm tabular-nums">
                <thead>
                  <tr className="text-left">
                    <th className="py-0.5 font-medium">When</th>
                    <th className="py-0.5 text-right font-medium">Submitted</th>
                    <th className="py-0.5 text-right font-medium">Rejected</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.filter((r) => r.up || r.down).map((r) => (
                    <tr key={r.key}>
                      <td className="py-0.5">{r.label}</td>
                      <td className="py-0.5 text-right">{r.up}</td>
                      <td className="py-0.5 text-right">{r.down}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </details>
          </Panel>

          <div className="grid gap-4 lg:grid-cols-2 xl:grid-cols-3">
            <Panel title="How far they got" note={`Applications sent ${period.span}, and the share that made each step`}>
              <Funnel
                steps={[
                  { label: 'Submitted', n: data.funnel.submitted },
                  { label: 'Heard back', n: data.funnel.heard },
                  { label: 'Talked to someone', n: data.funnel.talked },
                  { label: 'Interviewed', n: data.funnel.interviewed },
                  { label: 'Offer', n: data.funnel.offers },
                ]}
              />
            </Panel>
            <Panel title="Where they stand" note={`The same applications, as of now. Gone quiet means ${data.quietDays}+ days with no answer.`}>
              {active.length ? (
                <>
                  <SplitBar parts={active} />
                  <div className="mt-3">
                    <Legend items={active} />
                  </div>
                  <div className="mt-5 border-t pt-4">
                    <Figures
                      items={[
                        { label: 'Typical time to a no', value: inDays(data.speed.toRejection) },
                        { label: 'Tracking to submitted', value: inDays(data.speed.toSubmit) },
                        { label: 'Listing age when sent', value: inDays(data.speed.listingAge) },
                      ]}
                    />
                  </div>
                </>
              ) : (
                <Empty>Nothing submitted in this period.</Empty>
              )}
            </Panel>
            <Panel title="Why things closed" note={`Everything that closed ${period.span}, submitted or not`} className="lg:col-span-2 xl:col-span-1">
              {data.closed.length ? <RowBars rows={data.closed.map((c) => ({ ...c, color: c.kind === 'rejected' ? 'var(--viz-rejected)' : 'var(--muted-foreground)' }))} /> : <Empty>Nothing closed in this period.</Empty>}
            </Panel>
          </div>

          <div className="space-y-3">
            <div className="flex flex-wrap items-center justify-between gap-2 px-1">
              <h2 className="text-sm font-semibold tracking-tight">What's getting answers</h2>
              <Legend items={FARED_LEGEND} />
            </div>
            <div className="grid gap-4 lg:grid-cols-2 2xl:grid-cols-4">
              <Panel title="By fit score">
                <Fared rows={data.fared.fit} />
              </Panel>
              <Panel title="By top of the pay range">
                <Fared rows={data.fared.pay} />
              </Panel>
              <Panel title="By title">
                <Fared rows={data.fared.level} />
              </Panel>
              <Panel title="By application system">
                <Fared rows={data.fared.ats} />
              </Panel>
            </div>
          </div>

          <div className="grid gap-4 lg:grid-cols-3">
            <Panel title="Days you applied" note="All time" className="lg:col-span-2">
              <CalendarGrid days={data.calendar} today={new Date()} />
            </Panel>
            <Panel title="Your rhythm" note={`Streaks are all time; weekdays cover ${period.value === 'all' ? 'all time' : period.label.toLowerCase()}`}>
              <Figures
                items={[
                  { label: 'Current streak', value: `${data.streak.current}d` },
                  { label: 'Longest streak', value: `${data.streak.longest}d` },
                  { label: 'Days applied', value: data.activeDays },
                ]}
              />
              <div className="mt-4">
                <Columns rows={data.weekdays.map((d) => ({ key: d.label, label: d.label, n: d.n }))} height="h-20" labelAll noun="submitted" />
              </div>
            </Panel>
          </div>

          <div className="grid gap-4 lg:grid-cols-2 xl:grid-cols-3">
            <Panel title="What the scout went through" note={`Jobs first seen ${period.span}, from ${data.scout.active.toLocaleString()} active sources`}>
              <Funnel
                steps={[
                  { label: 'Jobs seen', n: data.scout.seen },
                  { label: 'Read by your AI', n: data.scout.read },
                  { label: 'Worth a look', n: data.scout.good },
                  { label: 'You tracked', n: data.scout.tracked },
                ]}
              />
              {t.seen.prev !== null && <Delta now={t.seen.now} prev={t.seen.prev} before={period.before} />}
            </Panel>
            <Panel title="Jobs seen" note={data.unit === 'hour' ? 'By hour' : data.unit === 'week' ? 'By week' : 'By day'}>
              <Columns rows={data.series.map((b) => ({ key: b.at, label: bucketLabel(b.at, data.unit), n: b.seen }))} noun="jobs seen" />
              <h4 className="mt-4 mb-2 text-xs text-muted-foreground">Fit scores from your AI</h4>
              {data.scout.fit.length ? <Columns height="h-20" labelAll rows={data.scout.fit.map((f) => ({ key: String(f.band), label: String(f.band), n: f.n }))} noun="jobs" /> : <Empty>Nothing scored in this period.</Empty>}
            </Panel>
            <Panel title="Sources with the best jobs" note="Most jobs worth a look" className="lg:col-span-2 xl:col-span-1">
              {data.scout.sources.length ? <RowBars rows={data.scout.sources} /> : <Empty>Nothing worth a look in this period.</Empty>}
            </Panel>
          </div>

          <div className="grid gap-4 lg:grid-cols-2">
            <Panel title="People and outreach" note={`Counts are ${period.span}; reply rate is all time`}>
              <Figures
                items={[
                  { label: 'People added', value: data.people.added.toLocaleString(), note: `${data.people.known.toLocaleString()} known` },
                  { label: 'Messages out', value: data.people.out },
                  { label: 'Replies in', value: data.people.in },
                  { label: 'Drafts written', value: data.people.draftsWritten.toLocaleString() },
                  { label: 'Drafts sent', value: data.people.draftsSent, note: `${data.people.draftsWaiting} waiting on you` },
                  { label: 'Reply rate', value: pct(data.people.contacted ? data.people.replied / data.people.contacted : null), note: `${data.people.replied} of ${data.people.contacted} contacted` },
                ]}
              />
              {data.people.channels.length > 0 && (
                <div className="mt-4 border-t pt-4">
                  <RowBars rows={data.people.channels.map((c) => ({ label: channel(c.label), n: c.out + c.in, note: `${c.out} out, ${c.in} in` }))} color="var(--viz-talking)" />
                </div>
              )}
            </Panel>
            <Panel title="Your AI's work" note="Cost is API-equivalent, as reported by the provider. On a subscription you don't pay it per task.">
              <Figures
                items={[
                  { label: 'Tasks finished', value: data.ai.done.toLocaleString(), ...(data.ai.failed ? { note: `${data.ai.failed} failed` } : {}) },
                  { label: 'Hours of AI work', value: data.ai.hours ?? 0 },
                  { label: 'Cost', value: usd(data.ai.cost), ...(data.ai.perApplication != null ? { note: `${usd(data.ai.perApplication)} per submission` } : {}) },
                  { label: 'Tailored resumes', value: data.ai.resumes },
                  { label: 'Questions answered', value: data.ai.questions },
                ]}
              />
              {data.ai.byKind.length > 0 && (
                <div className="mt-4 border-t pt-4">
                  <RowBars rows={data.ai.byKind.map((k) => ({ label: k.label, n: k.usd }))} format={usd} color="var(--viz-talking)" />
                </div>
              )}
            </Panel>
          </div>

          {data.records.length > 0 && (
            <div className="space-y-3">
              <h2 className="px-1 text-sm font-semibold tracking-tight">Records, all time</h2>
              <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3 2xl:grid-cols-4">
                {data.records.map((r) => {
                  const body = (
                    <>
                      <div className="text-xs text-muted-foreground">{r.label}</div>
                      <div className="mt-0.5 text-xl font-semibold tracking-tight">{r.value}</div>
                      <div className="truncate text-xs text-muted-foreground">{/^\d{4}-\d{2}-\d{2}$/.test(r.detail) ? dayLabel(r.detail) : r.detail}</div>
                    </>
                  )
                  return r.link ? (
                    <Link key={r.label} to="/applications/$id" params={{ id: r.link }} className="min-w-0 rounded-xl border bg-card p-4 transition-colors hover:border-primary/40">
                      {body}
                    </Link>
                  ) : (
                    <div key={r.label} className="min-w-0 rounded-xl border bg-card p-4">
                      {body}
                    </div>
                  )
                })}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  )
}
