import { useQuery, useSuspenseQuery } from '@tanstack/react-query'
import { createFileRoute, Link } from '@tanstack/react-router'
import { ArrowLeft, ArrowRight, Check, CheckCircle2, ExternalLink, Loader2, Send, WandSparkles } from 'lucide-react'
import { useState } from 'react'
import { z } from 'zod'
import { salaryRange } from '@sidedoor/shared/format'
import { BUCKET_META, REVIEW_BUCKETS, type ReviewBucket, stillOpen } from '@sidedoor/shared/review'
import { CompanyAvatar, Empty, Freshness, PageHeader, Salary } from '~/components/app/bits'
import { usePageContext } from '~/components/app/chat'
import { ApplicationQuestions } from '~/components/app/questions'
import { Decisions, isTuneQuestion, JobSummary, ListingGone, ResumeStep, type ReviewItem, ReviewStep, WritingChecklist } from '~/components/app/review'
import { Segmented } from '~/components/app/segmented'
import { Button } from '~/components/ui/button'
import { qo, rpc, setStageFn } from '~/lib/api'
import { useAction } from '~/lib/use-action'
import { cn } from '~/lib/utils'

export const Route = createFileRoute('/review')({
  validateSearch: z.object({ app: z.string().optional().catch(undefined), show: z.enum(REVIEW_BUCKETS).optional().catch(undefined) }),
  loader: ({ context }) => context.queryClient.ensureQueryData(qo.reviewQueue()),
  component: Review,
})

const TONE: Record<ReviewBucket, string> = {
  ai: 'text-info',
  tune: 'text-muted-foreground',
  answers: 'text-hot',
  writing: 'text-hot',
  ready: 'text-success',
  sending: 'text-info',
  stuck: 'text-destructive',
}

/** Everything waiting to go out, one application at a time: resume, questions, writing, send. */
function Review() {
  const { data } = useSuspenseQuery(qo.reviewQueue())
  const search = Route.useSearch()
  const navigate = Route.useNavigate()
  const tuneAll = useAction(() => rpc.tuneAll(), { success: (r) => (r.queued ? `Your AI will work through ${r.queued} resume${r.queued === 1 ? '' : 's'}` : 'Every resume is tuned') })
  const list = search.show ? data.filter((x) => x.bucket === search.show) : data
  const i = Math.max(0, list.findIndex((x) => x.id === search.app))
  const current = list[i]
  const go = (id: string | undefined) => void navigate({ search: (s) => ({ ...s, app: id }), replace: true })
  const untuned = data.filter((x) => !x.facts.tuned && x.bucket !== 'ai' && x.bucket !== 'sending').length
  const present = REVIEW_BUCKETS.filter((b) => data.some((x) => x.bucket === b))

  return (
    <div>
      <PageHeader
        title="Review"
        subtitle={data.length ? `${data.length} application${data.length === 1 ? '' : 's'} on the way out. Go down the list: resume, questions, writing, send.` : 'Nothing waiting. Applications land here once your AI has prepared them.'}
        actions={
          untuned > 0 ? (
            <Button size="sm" disabled={tuneAll.pending} onClick={() => void tuneAll.run(undefined)}>
              <WandSparkles /> Tune {untuned} resume{untuned === 1 ? '' : 's'}
            </Button>
          ) : undefined
        }
      />
      {data.length > 0 && (
        <div className="-mx-4 mb-4 overflow-x-auto px-4 scrollbar-none">
          <Segmented
            value={search.show ?? 'all'}
            options={[{ value: 'all', label: `All ${data.length}` }, ...present.map((b) => ({ value: b, label: `${BUCKET_META[b].label} ${data.filter((x) => x.bucket === b).length}` }))]}
            onChange={(v) => void navigate({ search: { ...(v === 'all' ? {} : { show: v as ReviewBucket }) }, replace: true })}
          />
        </div>
      )}
      {current ? (
        <div className="grid grid-cols-1 gap-6 lg:grid-cols-[20rem_minmax(0,1fr)]">
          <nav className="hidden lg:block">
            <ol className="sticky top-4 max-h-[calc(100dvh-2rem)] space-y-1 overflow-y-auto pr-1">
              {list.map((x) => (
                <li key={x.id}>
                  <button type="button" onClick={() => go(x.id)} className={cn('flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-left hover:bg-accent', x.id === current.id && 'bg-accent')}>
                    <CompanyAvatar name={x.companyName} className="size-7 text-xs" />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-sm font-medium">{x.companyName}</span>
                      <span className="block truncate text-xs text-muted-foreground">{x.role}</span>
                      <Freshness postedAt={x.postedAt} firstSeenAt={x.firstSeenAt} />
                    </span>
                    <span className="shrink-0 text-right">
                      {x.score != null && <span className="block text-xs font-medium tabular-nums">{x.score}</span>}
                      <span className={cn('block text-[11px]', TONE[x.bucket])}>{BUCKET_META[x.bucket].label}</span>
                    </span>
                  </button>
                </li>
              ))}
            </ol>
          </nav>
          <Application key={current.id} item={current} place={i + 1} total={list.length} prev={list[i - 1]?.id} next={list[i + 1]?.id} go={go} />
        </div>
      ) : (
        <Empty>{search.show ? `Nothing in ${BUCKET_META[search.show].label.toLowerCase()} right now.` : 'Nothing is waiting on you.'}</Empty>
      )}
    </div>
  )
}

function Application({ item, place, total, prev, next, go }: { item: ReviewItem; place: number; total: number; prev: string | undefined; next: string | undefined; go: (id: string | undefined) => void }) {
  const { data: d } = useQuery(qo.application(item.id))
  const questions = useQuery(qo.questions({ applicationId: item.id, status: 'all' })).data ?? []
  // Tuning's open questions sit under the resume instead.
  const settling = questions.filter((g) => !(isTuneQuestion(g) && g.status === 'open'))
  usePageContext(`/applications/${item.id}`, `application ${item.companyName} – ${item.role} (going through the review)`)
  if (!d) return <Loader2 className="size-5 animate-spin text-muted-foreground" />
  const f = item.facts
  const a = d.application
  const writing = item.writing
  const written = writing.filter((w) => w.done).length
  const openAsks = f.openQuestions + f.openDecisions
  const p = d.posting
  const comp = salaryRange(a.compText, a.compMin, a.compMax) ? { text: a.compText, min: a.compMin, max: a.compMax } : { text: p?.compText, min: p?.compMin, max: p?.compMax }
  const tuning = d.tasks.some((t) => (t.kind === 'tune' || t.kind === 'prep' || t.kind === 'match') && (t.status === 'queued' || t.status === 'running'))
  return (
    <div className="min-w-0 space-y-3 pb-20 md:pb-16">
      <div className="flex gap-3">
        <CompanyAvatar name={a.companyName} className="size-10" />
        <div className="min-w-0 flex-1">
          <div className="text-sm text-muted-foreground">{a.companyName}</div>
          <h2 className="text-lg font-semibold leading-tight">
            <Link to="/applications/$id" params={{ id: a.id }} className="underline-offset-2 hover:underline">
              {a.role}
            </Link>
          </h2>
          <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-0.5">
            {salaryRange(comp.text, comp.min, comp.max) ? <Salary {...comp} /> : <span className="text-xs text-muted-foreground">Pay not listed</span>}
            {(a.postedAt || p) && <Freshness postedAt={a.postedAt ?? p?.postedAt ?? null} firstSeenAt={p?.firstSeenAt ?? a.createdAt} />}
          </div>
          {a.shot != null && <div className="mt-1 text-xs text-muted-foreground">Your AI puts your odds of an interview at {a.shot}%</div>}
        </div>
        {(a.jobUrl || a.applyUrl) && (
          <Button asChild size="sm" variant="outline" className="shrink-0 self-start">
            <a href={(a.jobUrl ?? a.applyUrl)!} target="_blank" rel="noreferrer">
              <ExternalLink /> Listing
            </a>
          </Button>
        )}
      </div>
      <JobSummary d={d} />
      <ListingGone d={d} />

      <ReviewStep n={1} title="Resume" done={f.tuned && !tuning} working={tuning}>
        <ResumeStep d={d} working={tuning} questions={questions} />
      </ReviewStep>

      <ReviewStep n={2} title="Questions and decisions" done={!openAsks} note={openAsks ? `${openAsks} open` : undefined}>
        <div className="space-y-3">
          {!openAsks && !settling.length && <p className="text-sm text-muted-foreground">Nothing to settle on this one.</p>}
          <ApplicationQuestions applicationId={a.id} groups={settling} hasPackage />
          <Decisions d={d} />
        </div>
      </ReviewStep>

      <ReviewStep n={3} title="Writing" done={!f.writingLeft} note={writing.length ? `${written} of ${writing.length} checked` : undefined}>
        <WritingChecklist d={d} />
      </ReviewStep>

      <ReviewStep n={4} title="Send" done={false} working={f.sending}>
        <SendStep item={item} onSent={() => go(next)} />
      </ReviewStep>

      <div className="sticky bottom-20 flex items-center gap-2 rounded-xl border bg-background/95 p-2 backdrop-blur md:bottom-3">
        <Button variant="ghost" size="sm" disabled={!prev} onClick={() => go(prev)}>
          <ArrowLeft /> Previous
        </Button>
        <span className="flex-1 text-center text-xs text-muted-foreground tabular-nums">
          {place} of {total}
        </span>
        <Button size="sm" disabled={!next} onClick={() => go(next)}>
          Next <ArrowRight />
        </Button>
      </div>
    </div>
  )
}

/** Why the last submit stopped short, and what gets it going again. */
function StoppedForQuestions({ s, open }: { s: NonNullable<ReviewItem['submission']>; open: number }) {
  return (
    <div className="space-y-2 rounded-lg bg-hot/10 p-3 text-sm">
      <div className="font-medium">{s.dryRun ? 'The dry run stopped on questions.' : 'Not submitted: the form asked things Sidedoor couldn’t answer for you.'}</div>
      {s.questions.length > 0 && (
        <ul className="space-y-1">
          {s.questions.map((q, i) => (
            <li key={i}>
              <span className="font-medium">{q.question}</span> <span className="text-muted-foreground">: {q.why}</span>
            </li>
          ))}
        </ul>
      )}
      <div className="text-muted-foreground">
        {open
          ? `Answer ${open === 1 ? 'it' : 'them'} under Questions and decisions and Sidedoor picks the form up where it stopped and submits it. The form is still open in the Sidedoor browser window if you’d rather finish it yourself.`
          : 'You’ve answered these since. Press Approve & submit to send it again.'}
      </div>
    </div>
  )
}

/** The last step. Pressing the button is what sends it: Sidedoor fills the form and submits only if every required answer is confirmed. */
function SendStep({ item, onSent }: { item: ReviewItem; onSent: () => void }) {
  const [confirming, setConfirming] = useState(false)
  const send = useAction(() => rpc.approveAndSubmit({ id: item.id }), { success: 'Sidedoor is filling the form. It comes back here if the form asks anything new.' })
  const approve = useAction(() => setStageFn({ data: { id: item.id, stage: 'approved' } }), { success: 'Approved. Open it to fill the form and submit it yourself.' })
  const open = stillOpen(item.facts)
  const s = item.submission
  const go = async () => {
    const sent = await send.run(undefined)
    setConfirming(false)
    if (sent) onSent()
  }
  if (item.facts.sending)
    return <p className="text-sm text-muted-foreground">Sidedoor is filling this form in its own window, one form at a time. You’ll get a notification when it’s in.</p>
  return (
    <div className="space-y-3">
      {s && !s.dryRun && s.status !== 'questions' && <div className={cn('rounded-lg p-3 text-sm', item.bucket === 'stuck' ? 'bg-destructive/10' : 'bg-muted/50')}>{s.summary}</div>}
      {s?.status === 'questions' && <StoppedForQuestions s={s} open={item.facts.openQuestions} />}
      {s?.dryRun && s.status === 'ready' && (
        <div className="flex items-center gap-1.5 text-sm text-success">
          <Check className="size-4" /> A dry run of this form found nothing left to ask.
        </div>
      )}
      <p className="text-sm text-muted-foreground">
        {confirming
          ? `Still open: ${open.join(', ')}. Send it anyway? It stops and comes back to you if a required answer isn’t confirmed.`
          : open.length
            ? `Still open: ${open.join(', ')}.`
            : 'Everything’s done. Sidedoor fills the form from this package and submits it. If the form asks something new, it stops and asks you here.'}
      </p>
      <div className="flex flex-wrap gap-2">
        {confirming ? (
          <>
            <Button disabled={send.pending} onClick={() => void go()}>
              <Send /> Send anyway
            </Button>
            <Button variant="ghost" onClick={() => setConfirming(false)}>
              Not yet
            </Button>
          </>
        ) : (
          <>
            <Button variant={open.length ? 'outline' : 'default'} disabled={send.pending} onClick={() => (open.length ? setConfirming(true) : void go())}>
              <Send /> Approve &amp; submit
            </Button>
            {item.stage === 'review' && (
              <Button variant="ghost" disabled={approve.pending} onClick={() => void approve.run(undefined)}>
                <CheckCircle2 /> Approve, I’ll submit it myself
              </Button>
            )}
          </>
        )}
      </div>
    </div>
  )
}
