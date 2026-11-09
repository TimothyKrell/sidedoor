import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Link } from '@tanstack/react-router'
import { ArrowRight, Check, CheckCircle2, ChevronRight, Circle, FileText, ListChecks, Loader2, MessageSquare, Sparkles, Undo2, WandSparkles } from 'lucide-react'
import { type ReactNode, useState } from 'react'
import { toast } from 'sonner'
import { decisionsOf } from '@sidedoor/shared/decisions'
import { BUCKET_META, type ReviewBucket, TUNE_STOP_LABEL, type WritingItem, writingItems } from '@sidedoor/shared/review'
import { fmtDate, type Stage } from '@sidedoor/shared/format'
import { Button } from '~/components/ui/button'
import { Textarea } from '~/components/ui/textarea'
import { type ApplicationDetail, qo, requestChangesFn, rpc, setStageFn, startTaskFn } from '~/lib/api'
import { useAction } from '~/lib/use-action'
import { cn } from '~/lib/utils'
import { Section, TimeAgo } from './bits'
import { useChat } from './chat'
import { MatchRing } from './match'
import { type QuestionGroup, QuestionList } from './questions'

type Detail = ApplicationDetail
export type ReviewItem = Awaited<ReturnType<typeof rpc.reviewQueue>>[number]

/** What the job is, before you get into the steps. Written in the background once a package is ready. */
export function JobSummary({ d }: { d: Detail }) {
  const start = useAction((v: { kind: 'brief'; applicationId: string }) => startTaskFn({ data: v }), { success: 'Your AI is reading the listing' })
  const a = d.application
  if (a.brief)
    return (
      <div className="rounded-lg bg-muted/50 p-3 text-sm">
        <p>{a.brief.summary}</p>
        {a.brief.highlights.length > 0 && (
          <ul className="mt-2 list-disc space-y-0.5 pl-4 text-muted-foreground">
            {a.brief.highlights.map((h) => (
              <li key={h}>{h}</li>
            ))}
          </ul>
        )}
      </div>
    )
  if (d.tasks.some((t) => t.kind === 'brief' && (t.status === 'queued' || t.status === 'running')))
    return <p className="text-sm text-muted-foreground">Your AI is reading the listing for a summary of this job.</p>
  return (
    <Button size="sm" variant="ghost" disabled={start.pending} onClick={() => void start.run({ kind: 'brief', applicationId: a.id })}>
      <Sparkles /> Summarize this job
    </Button>
  )
}

/** Open the application's own chat, with your AI's findings waiting in it. */
export function useApplicationChat(id: string) {
  const chat = useChat()
  return async () => {
    try {
      const { threadId } = await rpc.applicationChat({ id })
      chat.setThreadId(threadId)
      chat.setOpen(true)
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e))
    }
  }
}

/** One numbered step on the Review page. */
export function ReviewStep({ n, title, done, working, note, children }: { n: number; title: string; done: boolean; working?: boolean; note?: ReactNode; children: ReactNode }) {
  return (
    <section className={cn('rounded-xl border bg-card p-4', done && 'border-success/30')}>
      <div className="mb-3 flex items-center gap-2.5">
        <span className={cn('flex size-6 shrink-0 items-center justify-center rounded-full text-xs font-semibold', done ? 'bg-success/15 text-success' : 'bg-primary/12 text-primary')}>
          {working ? <Loader2 className="size-3.5 animate-spin" /> : done ? <Check className="size-3.5" /> : n}
        </span>
        <h2 className="min-w-0 flex-1 text-sm font-semibold">{title}</h2>
        {note && <span className="shrink-0 text-xs text-muted-foreground">{note}</span>}
      </div>
      {children}
    </section>
  )
}

/** Optional questions tuning left about requirements still short: kept out of the way, under the resume. */
export const isTuneQuestion = (g: QuestionGroup) => g.askedBy === 'tune' && g.optional

/** The match, what the AI did to raise it, the questions that could raise it further, and the way into the chat about it. */
export function ResumeStep({ d, working, questions }: { d: Detail; working: boolean; questions: QuestionGroup[] }) {
  const a = d.application
  const talk = useApplicationChat(a.id)
  const tune = useAction((v: { kind: 'tune'; applicationId: string }) => startTaskFn({ data: v }), { success: 'Your AI is working on the resume' })
  const [asking, setAsking] = useState(false)
  const t = a.tuneJson
  const asks = questions.filter((g) => isTuneQuestion(g) && g.status === 'open')
  // Answered since the last pass: what a new pass has to work with.
  const fresh = questions.filter((g) => isTuneQuestion(g) && g.status === 'answered' && (!t || (g.answeredAt ?? '') > t.at)).length
  const failed = d.tasks.find((x) => x.kind === 'tune')?.status === 'failed' ? d.tasks.find((x) => x.kind === 'tune') : null
  const m = a.matchJson
  return (
    <div className="space-y-3">
      <div className="flex items-start gap-3">
        {m && <MatchRing score={m.score} size={56} className="shrink-0" />}
        <div className="min-w-0 flex-1 text-sm">
          {working ? (
            <div className="font-medium">Your AI is working this resume up. It stops when the score stops rising.</div>
          ) : t ? (
            <>
              <div className="font-medium">
                {t.rounds === 0 ? `Already at ${t.to}` : t.to > t.from ? `Your AI raised it from ${t.from} to ${t.to}` : `Your AI held it at ${t.to}`}
                {t.rounds > 0 && <span className="font-normal text-muted-foreground"> in {t.rounds} round{t.rounds === 1 ? '' : 's'}</span>}
              </div>
              <div className="text-xs text-muted-foreground">
                {TUNE_STOP_LABEL[t.stopped]} · <TimeAgo iso={t.at} />
              </div>
              <div className="mt-1.5 text-muted-foreground">{t.summary}</div>
            </>
          ) : (
            <div className="font-medium">Your AI hasn’t pushed this resume as far as it can yet.</div>
          )}
          {failed && <div className="mt-1.5 text-destructive">Last try failed: {failed.error}</div>}
        </div>
      </div>
      <div className="flex flex-wrap gap-2">
        <Button size="sm" variant={t ? 'default' : 'outline'} onClick={() => void talk()}>
          <MessageSquare /> Talk it through
        </Button>
        <Button size="sm" variant={t && !fresh ? 'outline' : 'default'} disabled={working || tune.pending} onClick={() => void tune.run({ kind: 'tune', applicationId: a.id })}>
          <WandSparkles /> {fresh ? `Tune again with ${fresh} answer${fresh === 1 ? '' : 's'}` : t ? 'Tune again' : 'Tune resume'}
        </Button>
        {d.resume && (
          <Button asChild size="sm" variant="outline">
            <Link to="/resume/$id" params={{ id: d.resume.id }}>
              See the resume
            </Link>
          </Button>
        )}
        <Button asChild size="sm" variant="ghost">
          <Link to="/applications/$id" params={{ id: a.id }} search={{ tab: 'match' }}>
            <ListChecks /> Requirements
          </Link>
        </Button>
      </div>
      {asks.length > 0 && (
        <div className="space-y-2">
          <button type="button" className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground" onClick={() => setAsking(!asking)}>
            <ChevronRight className={cn('size-3.5 transition-transform', asking && 'rotate-90')} />
            {asks.length} question{asks.length === 1 ? '' : 's'} that could raise the match
          </button>
          {asking && (
            <>
              <p className="text-xs text-muted-foreground">Optional: it can go without them. Answers are kept in your Experience, so later tunings use them too, here and on other jobs.</p>
              <QuestionList groups={asks} showApplications={false} />
            </>
          )}
        </div>
      )}
    </div>
  )
}

type Voice = 'mine' | 'spunky' | 'milady'
/** A template is `tpl:<id>`. */
type Help = 'draft' | 'cleanup' | Voice | `tpl:${string}`

const VOICES: { voice: Voice; label: string; title: string }[] = [
  { voice: 'mine', label: 'My voice', title: 'Rewrites it the way you sound' },
  { voice: 'spunky', label: 'Spunky', title: 'Cheekier and more confident, with the same true story. Fine at most companies' },
  { voice: 'milady', label: 'Milady', title: 'Lowercase, the way a long-time poster writes. For crypto companies only' },
]

function WritingRow({ id, item }: { id: string; item: WritingItem }) {
  const [text, setText] = useState(item.blank ? '' : item.text)
  const [open, setOpen] = useState(!item.done)
  const save = useAction((v: { done: boolean; text?: string }) => rpc.setWriting({ id, key: item.key, ...v }))
  const assist = useAction((mode: Help) =>
    mode === 'draft' || mode === 'cleanup'
      ? rpc.assistWriting({ id, key: item.key, mode, text })
      : mode.startsWith('tpl:')
        ? rpc.restyleCoverLetter({ id, template: mode.slice(4), text })
        : rpc.restyleCoverLetter({ id, voice: mode as Voice, text }),
  )
  const { data: settings } = useQuery({ ...qo.settings(), enabled: item.key === 'cover-letter' })
  const templates = settings?.settings.coverLetters.templates ?? []
  const defaultTemplate = settings?.settings.coverLetters.defaultTemplate
  const [undo, setUndo] = useState<string | null>(null)
  const [mode, setMode] = useState<Help | null>(null)
  const [note, setNote] = useState<string | null>(null)
  const changed = text.trim() !== item.text.trim()
  /** Fills the box and saves nothing. What was there stays one click away. */
  const help = async (m: Help) => {
    setMode(m)
    const r = await assist.run(m)
    setMode(null)
    if (!r) return
    setUndo(text)
    setText(r.text)
    setNote(r.note)
  }
  return (
    <li className="py-3 first:pt-0 last:pb-0">
      <div className="flex items-start gap-2.5">
        <button type="button" className="mt-0.5 shrink-0" aria-label={item.done ? 'Reopen' : 'Check off'} disabled={save.pending || !text.trim()} onClick={() => void save.run({ done: !item.done, ...(changed ? { text } : {}) })}>
          {item.done ? <CheckCircle2 className="size-4 text-success" /> : <Circle className="size-4 text-muted-foreground" />}
        </button>
        <button type="button" className="min-w-0 flex-1 text-left text-sm font-medium" onClick={() => setOpen(!open)}>
          <span className={cn(item.done && 'text-muted-foreground')}>{item.title}</span>
          {item.blank && <span className="ml-2 text-xs font-normal text-hot">for you to write</span>}
        </button>
      </div>
      {open && (
        <div className="mt-2 space-y-2 pl-6.5">
          <Textarea value={text} disabled={assist.pending} onChange={(e) => setText(e.target.value)} rows={Math.min(14, Math.max(4, Math.ceil(text.length / 90)))} placeholder="Ramble here in your own words, then clean it up. Or have your AI draft it." />
          <div className="flex flex-wrap items-center gap-2">
            <Button size="sm" variant="outline" className="h-7 text-xs" disabled={assist.pending} onClick={() => void help('draft')} title="Writes it from your Experience and stories, building on anything in the box">
              {mode === 'draft' ? <Loader2 className="animate-spin" /> : <WandSparkles />} {text.trim() ? 'Redraft it' : 'Draft it for me'}
            </Button>
            <Button size="sm" variant="outline" className="h-7 text-xs" disabled={assist.pending || !text.trim()} onClick={() => void help('cleanup')} title="Organizes what you wrote and tidies it up, without adding anything you didn't say">
              {mode === 'cleanup' ? <Loader2 className="animate-spin" /> : <Sparkles />} Clean up my answer
            </Button>
            {item.key === 'cover-letter' &&
              VOICES.map((v) => (
                <Button key={v.voice} size="sm" variant="outline" className="h-7 text-xs" disabled={assist.pending} onClick={() => void help(v.voice)} title={v.title}>
                  {mode === v.voice && <Loader2 className="animate-spin" />} {v.label}
                </Button>
              ))}
            {item.key === 'cover-letter' &&
              templates.map((t) => (
                <Button key={t.id} size="sm" variant="outline" className="h-7 text-xs" disabled={assist.pending} onClick={() => void help(`tpl:${t.id}`)} title={`Writes it from your template "${t.name}", keeping your own text as you wrote it`}>
                  {mode === `tpl:${t.id}` ? <Loader2 className="animate-spin" /> : <FileText />} {t.name}
                  {t.id === defaultTemplate && <span className="text-muted-foreground">(default)</span>}
                </Button>
              ))}
            {item.key === 'cover-letter' && settings && !templates.length && (
              <Button asChild size="sm" variant="ghost" className="h-7 text-xs text-muted-foreground">
                <Link to="/settings" search={{ section: 'letters' }} title="Write your own letter with parts for your AI to fill in">
                  <FileText /> Use a template
                </Link>
              </Button>
            )}
            {undo !== null && !assist.pending && (
              <Button size="sm" variant="ghost" className="h-7 text-xs" onClick={() => { setText(undo); setUndo(null); setNote(null) }}>
                <Undo2 /> Undo
              </Button>
            )}
          </div>
          {note && <p className="text-xs text-hot">{note}</p>}
          <div className="flex flex-wrap items-center gap-2">
            <Button size="sm" className="h-7 text-xs" disabled={save.pending || !text.trim()} onClick={async () => { await save.run({ done: true, ...(changed ? { text } : {}) }); setOpen(false) }}>
              <Check /> {changed ? 'Save and check off' : 'Reads right, check off'}
            </Button>
            {changed && !item.blank && (
              <Button size="sm" variant="ghost" className="h-7 text-xs" disabled={save.pending} onClick={() => void save.run({ done: false, text })}>
                Save for later
              </Button>
            )}
            <span className="text-xs text-muted-foreground tabular-nums">{text.trim() ? text.trim().split(/\s+/).length : 0} words</span>
          </div>
        </div>
      )}
    </li>
  )
}

/** Every essay, letter and free-text answer, in one list to write or check off. */
export function WritingChecklist({ d }: { d: Detail }) {
  const a = d.application
  const items = writingItems(a.packageMd, a.writingChecks)
  if (!items.length) return <p className="text-sm text-muted-foreground">This form has no essays or cover letter.</p>
  return (
    <ul className="divide-y">
      {items.map((w) => (
        // Remounts when the text changes under it (the AI revised the package), so the box never holds stale text.
        <WritingRow key={`${w.key}:${w.text.length}`} id={a.id} item={w} />
      ))}
    </ul>
  )
}

const TILES: ReviewBucket[] = ['tune', 'answers', 'writing', 'ready', 'stuck']

/** Today's top line: how many applications sit at each step, and the way in. */
export function ReviewBanner() {
  const { data } = useQuery(qo.reviewQueue())
  if (!data?.length) return null
  const count = (b: ReviewBucket) => data.filter((x) => x.bucket === b).length
  const working = count('ai') + count('sending')
  return (
    <Section
      title="Get applications out"
      count={data.length}
      action={
        <Button asChild size="sm">
          <Link to="/review">
            Start reviewing <ArrowRight />
          </Link>
        </Button>
      }
    >
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        {TILES.filter((b) => b !== 'stuck' || count(b)).map((b) => (
          <Link key={b} to="/review" search={{ show: b }} className={cn('rounded-xl border bg-card p-3 transition-colors hover:bg-accent', b === 'ready' && count(b) > 0 && 'border-success/40', !count(b) && 'opacity-60')}>
            <div className="text-xl font-semibold tabular-nums">{count(b)}</div>
            <div className="text-sm font-medium">{BUCKET_META[b].label}</div>
            <div className="mt-0.5 text-xs text-muted-foreground">{BUCKET_META[b].hint}</div>
          </Link>
        ))}
      </div>
      {working > 0 && (
        <div className="mt-2 flex items-center gap-1.5 text-xs text-muted-foreground">
          <Loader2 className="size-3 animate-spin" /> {count('ai') > 0 && `Your AI is working on ${count('ai')}.`} {count('sending') > 0 && `Sidedoor is sending ${count('sending')}.`}
        </div>
      )}
    </Section>
  )
}

/** Prepared work whose listing disappeared: check before spending more on it. */
export function ListingGone({ d }: { d: Detail }) {
  const qc = useQueryClient()
  const stage = useAction((v: { id: string; stage: Stage; closedReason?: string }) => setStageFn({ data: v }))
  const closedAt = d.listingClosedAt
  if (!closedAt) return null
  const reopen = async () => {
    await rpc.listingStillOpen({ ...(d.posting ? { postingId: d.posting.id } : {}), applicationId: d.application.id })
    await qc.invalidateQueries({ queryKey: ['application', d.application.id] })
  }
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-2 rounded-lg bg-destructive/10 px-3 py-2 text-sm">
      <span className="min-w-0 flex-1 basis-64">
        <span className="font-medium">The listing was taken down {fmtDate(closedAt)}.</span> Check the company’s site before you submit.
        {d.application.listingEvidence && <span className="block text-xs text-muted-foreground">{d.application.listingEvidence}</span>}
      </span>
      <Button size="sm" variant="outline" className="h-7 bg-background" onClick={() => void reopen()}>
        It’s still open
      </Button>
      <Button size="sm" variant="ghost" className="h-7" disabled={stage.pending} onClick={() => void stage.run({ id: d.application.id, stage: 'closed', closedReason: 'Listing closed' })}>
        Close it
      </Button>
    </div>
  )
}

/**
 * The package's "Needs your decision" items. Each is fine as is or gets your answer; answers are
 * kept in the package and go to your AI together, as one revision.
 */
export function Decisions({ d }: { d: Detail }) {
  const a = d.application
  const items = decisionsOf(a.packageMd)
  const qc = useQueryClient()
  const [answering, setAnswering] = useState<string | null>(null)
  const [answer, setAnswer] = useState('')
  const changes = useAction((v: { id: string; notes: string }) => requestChangesFn({ data: v }), { success: 'Sent to your AI. It’s revising the package with your answers.' })
  const settleAll = useAction(() => rpc.settleDecisions({ id: a.id }))
  if (!items.length) return null
  const open = items.filter((x) => !x.done).length
  const answered = items.filter((x) => x.answer)
  const settle = async (text: string, done: boolean, ans?: string | null) => {
    try {
      await rpc.setDecision({ id: a.id, text, done, answer: ans ?? null })
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e))
    }
    await qc.invalidateQueries({ queryKey: ['application', a.id] })
  }
  const sendAll = () =>
    changes.run({
      id: a.id,
      notes: `My answers to the open decisions:\n${answered.map((x) => `- ${x.text.replace(/\*\*/g, '')}\n  My answer: ${x.answer}`).join('\n')}`,
    })
  return (
    <section className="rounded-xl border bg-card p-4">
      <div className="flex flex-wrap items-start gap-x-3 gap-y-2">
        <div className="min-w-0 flex-1">
          <h3 className="text-sm font-semibold">{open ? `${open} decision${open === 1 ? '' : 's'} for you` : 'Decisions made'}</h3>
          <p className="mt-0.5 text-xs text-muted-foreground">Things your AI couldn’t settle on its own.</p>
        </div>
        {open > 1 && (
          <Button size="sm" variant="outline" disabled={settleAll.pending} onClick={() => void settleAll.run(undefined)}>
            All fine as is
          </Button>
        )}
        {answered.length > 0 && (
          <Button size="sm" disabled={changes.pending} onClick={() => void sendAll()}>
            Send {answered.length} answer{answered.length === 1 ? '' : 's'} to your AI
          </Button>
        )}
      </div>
      <ul className="mt-3 divide-y">
        {items.map((x) => {
          const text = x.text.replace(/\*\*/g, '')
          return (
            <li key={x.line} className="py-2.5 first:pt-0 last:pb-0">
              <div className="flex flex-wrap items-start gap-x-2.5 gap-y-1.5 text-sm">
                <span className="mt-0.5 shrink-0">{x.done ? <Check className="size-4 text-success" /> : <Circle className="size-4 text-muted-foreground" />}</span>
                <div className="min-w-0 flex-1 basis-60">
                  <div className={cn(x.done && 'text-muted-foreground')}>{text}</div>
                  {x.done && <div className="mt-0.5 text-xs text-muted-foreground">{x.answer ? <span className="text-foreground">You: {x.answer}</span> : 'Fine as is'}</div>}
                </div>
                {answering !== x.text && (
                  <div className="flex shrink-0 gap-1 max-sm:w-full max-sm:pl-6.5">
                    {x.done ? (
                      <Button
                        size="sm"
                        variant="ghost"
                        className="h-7 text-xs"
                        onClick={() => {
                          // Reopening an answer puts it back in the box to edit.
                          if (x.answer) {
                            setAnswering(x.text)
                            setAnswer(x.answer)
                          }
                          void settle(x.text, false)
                        }}
                      >
                        {x.answer ? 'Edit' : 'Undo'}
                      </Button>
                    ) : (
                      <>
                        <Button size="sm" variant="ghost" className="h-7 text-xs" onClick={() => void settle(x.text, true)}>
                          Fine as is
                        </Button>
                        <Button size="sm" variant="outline" className="h-7 text-xs" onClick={() => { setAnswering(x.text); setAnswer('') }}>
                          Answer…
                        </Button>
                      </>
                    )}
                  </div>
                )}
              </div>
              {answering === x.text && (
                <div className="mt-2 space-y-2 pl-6.5">
                  <Textarea value={answer} onChange={(e) => setAnswer(e.target.value)} rows={2} autoFocus placeholder="Your answer. It goes to your AI with any others when you send them." />
                  <div className="flex gap-2">
                    <Button size="sm" variant="outline" disabled={!answer.trim()} onClick={async () => { await settle(x.text, true, answer); setAnswering(null) }}>
                      Save answer
                    </Button>
                    <Button size="sm" variant="ghost" onClick={() => setAnswering(null)}>
                      Cancel
                    </Button>
                  </div>
                </div>
              )}
            </li>
          )
        })}
      </ul>
    </section>
  )
}
