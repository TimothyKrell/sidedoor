import { useQueryClient, useSuspenseQuery } from '@tanstack/react-query'
import { createFileRoute, Link } from '@tanstack/react-router'
import { Bot, Check, CheckCircle2, ChevronDown, Circle, ExternalLink, FileText, ListChecks, Loader2, Mail, PartyPopper, Pencil, Plus, Search, Send, ThumbsDown, Undo2, UserSearch, WandSparkles } from 'lucide-react'
import { useMemo, useState } from 'react'
import { z } from 'zod'
import { CompanyAvatar, CopyButton, Due, Empty, FitBadge, Freshness, LocationNote, Markdown, Section, StageBadge, TimeAgo } from '~/components/app/bits'
import { DraftCard, PersonRow } from '~/components/app/cards'
import { useChat, usePageContext } from '~/components/app/chat'
import { MatchList, MatchStrip, MatchSummary } from '~/components/app/match'
import { WritingReview } from '~/components/app/writing'
import { FollowupPicker, InteractionForm, PersonDialog } from '~/components/app/forms'
import { Badge } from '~/components/ui/badge'
import { Button } from '~/components/ui/button'
import { Input } from '~/components/ui/input'
import { Label } from '~/components/ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '~/components/ui/select'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '~/components/ui/tabs'
import { Textarea } from '~/components/ui/textarea'
import { editPackageFn, type getApplicationFn, qo, requestChangesFn, rpc, setStageFn, startTaskFn, updateApplicationFn } from '~/lib/api'
import { toast } from 'sonner'
import { extractProseSections, replaceSections } from '@sidedoor/shared/package-sections'
import { decisionsOf, withoutDecisions } from '@sidedoor/shared/decisions'
import { fmtDate, STAGE_META, STAGES, type Stage } from '@sidedoor/shared/format'
import { useAction } from '~/lib/use-action'
import { cn } from '~/lib/utils'

const TABS = ['package', 'match', 'people', 'research', 'timeline', 'details'] as const
type Tab = (typeof TABS)[number]

/** 'hiring-manager' → 'Hiring manager'. */
const roleLabel = (r: string) => (r.charAt(0).toUpperCase() + r.slice(1)).replace(/-/g, ' ')

export const Route = createFileRoute('/applications/$id')({
  // The tab lives in the URL so Back from a person/job page returns to the same tab.
  validateSearch: z.object({ tab: z.enum(TABS).optional().catch(undefined) }),
  loader: ({ context, params }) => context.queryClient.ensureQueryData(qo.application(params.id)),
  component: ApplicationPage,
})

type Detail = NonNullable<Awaited<ReturnType<typeof getApplicationFn>>>

const fileUrl = (rel: string | null | undefined) => (rel ? `/files/${rel.split('/').map(encodeURIComponent).join('/')}` : null)

function ApplicationPage() {
  const { id } = Route.useParams()
  const { tab } = Route.useSearch()
  const navigate = Route.useNavigate()
  const { data } = useSuspenseQuery(qo.application(id))
  const a = data?.application
  usePageContext(`/applications/${id}`, a ? `application ${a.companyName} – ${a.role} (${STAGE_META[a.stage].label.toLowerCase()})` : undefined)
  if (!data || !a) return <Empty>Application not found.</Empty>
  const runningTasks = data.tasks.filter((t) => t.status === 'running' || t.status === 'queued')
  const defaultTab = a.stage === 'review' || a.stage === 'approved' ? 'package' : data.people.length || data.drafts.length ? 'people' : a.packageMd ? 'package' : 'timeline'

  return (
    <div className="space-y-5">
      <div className="flex gap-3">
        <CompanyAvatar name={a.companyName} className="size-12 text-lg" />
        <div className="min-w-0 flex-1">
          <div className="text-sm text-muted-foreground">{a.companyName}</div>
          <h1 className="text-lg font-semibold leading-tight tracking-tight md:text-2xl">{a.role}</h1>
          {/* Separate items with gaps, not leading dots, so a wrapped line never starts with "·". */}
          <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
            <FitBadge fit={a.fitScore} className="h-5 text-[11px]" />
            {a.priority === 'high' && <Badge variant="outline" className="border-primary/50 text-primary">high priority</Badge>}
            {a.location && !/^unknown$/i.test(a.location) && <span>{a.location.replace(/\s*\|\s*/g, ' · ')}</span>}
            {a.compText && !/^(unknown|not (published|listed|stated))\.?$/i.test(a.compText.trim()) && <span>{a.compText}</span>}
            {a.appliedAt && <span>Applied {fmtDate(a.appliedAt)}</span>}
            {data.posting && (
              <Link to="/jobs/$id" params={{ id: data.posting.id }} className="underline-offset-2 hover:underline">
                <Freshness postedAt={data.posting.postedAt} firstSeenAt={data.posting.firstSeenAt} />
              </Link>
            )}
            {data.posting?.closedAt && <Badge variant="destructive">Listing closed {fmtDate(data.posting.closedAt)}</Badge>}
          </div>
          {data.posting && <LocationNote fit={data.posting.locationFit} note={data.posting.locationNote} />}
        </div>
        {(a.jobUrl || a.applyUrl) && (
          <Button asChild size="sm" variant="outline" className="shrink-0 self-start">
            <a href={(a.jobUrl ?? a.applyUrl)!} target="_blank" rel="noreferrer" title={(a.jobUrl ?? a.applyUrl)!}>
              <ExternalLink /> <span className="hidden sm:inline">View listing</span><span className="sm:hidden">Listing</span>
            </a>
          </Button>
        )}
      </div>

      <StageStepper id={a.id} stage={a.stage} />

      {runningTasks.length > 0 && (
        <div className="space-y-1.5">
          {runningTasks.map((t) => (
            <div key={t.id} className="flex items-center gap-2 rounded-lg border border-info/30 bg-info/10 px-3 py-2 text-sm">
              <Loader2 className={cn('size-4 text-info', t.status === 'running' && 'animate-spin')} />
              <span className="truncate">{t.title}</span>
              <span className="ml-auto shrink-0 text-xs text-muted-foreground">{t.status === 'running' ? <>started <TimeAgo iso={t.startedAt} /></> : 'queued'}</span>
            </div>
          ))}
        </div>
      )}

      <NextStep d={data} />

      {a.matchJson && (tab ?? defaultTab) !== 'match' && <MatchStrip match={a.matchJson} stale={data.matchStale} onOpen={() => void navigate({ search: (s) => ({ ...s, tab: 'match' }), replace: true })} />}

      <Tabs value={tab ?? defaultTab} onValueChange={(v) => void navigate({ search: (s) => ({ ...s, tab: v as Tab }), replace: true })}>
        <TabsList className="w-full justify-start overflow-x-auto scrollbar-none">
          <TabsTrigger value="package">Package</TabsTrigger>
          <TabsTrigger value="match">
            Match {a.matchJson && <span className="text-muted-foreground tabular-nums">{a.matchJson.score}</span>}
          </TabsTrigger>
          <TabsTrigger value="people">
            People {data.people.length > 0 && <span className="text-muted-foreground">{data.people.length}</span>}
          </TabsTrigger>
          <TabsTrigger value="research">Research</TabsTrigger>
          <TabsTrigger value="timeline">Timeline</TabsTrigger>
          <TabsTrigger value="details">Details</TabsTrigger>
        </TabsList>
        <TabsContent value="package" className="mt-4">
          <PackageTab d={data} />
        </TabsContent>
        <TabsContent value="match" className="mt-4">
          <MatchTab d={data} />
        </TabsContent>
        <TabsContent value="people" className="mt-4">
          <PeopleTab d={data} />
        </TabsContent>
        <TabsContent value="research" className="mt-4">
          <ResearchTab d={data} />
        </TabsContent>
        <TabsContent value="timeline" className="mt-4">
          <TimelineTab d={data} />
        </TabsContent>
        <TabsContent value="details" className="mt-4">
          <DetailsTab d={data} />
        </TabsContent>
      </Tabs>
    </div>
  )
}

function StageStepper({ id, stage }: { id: string; stage: string }) {
  const set = useAction((d: { id: string; stage: Stage }) => setStageFn({ data: d }))
  const idx = STAGES.indexOf(stage as Stage)
  return (
    <div className="-mx-4 overflow-x-auto px-4 scrollbar-none">
      <div className="flex min-w-max gap-1">
        {STAGES.filter((s) => s !== 'closed').map((s, i) => (
          <button
            key={s}
            type="button"
            disabled={set.pending}
            onClick={() => s !== stage && void set.run({ id, stage: s })}
            className={cn(
              'rounded-md px-2.5 py-1 text-[11px] transition-colors',
              s === stage ? cn(STAGE_META[s].tone, 'font-semibold ring-1 ring-current/30') : i < idx ? 'text-muted-foreground/90 hover:bg-accent' : 'text-muted-foreground/50 hover:bg-accent hover:text-muted-foreground',
            )}
          >
            {STAGE_META[s].short}
          </button>
        ))}
      </div>
    </div>
  )
}

type FillReport = { outcome: 'ready' | 'needs_you' | 'blocked'; summary: string; filled: { field: string; value: string }[]; needsYou: { field: string; why: string }[] }
const parseReport = (out: string | null): FillReport | null => {
  try {
    const r = out ? (JSON.parse(out) as FillReport) : null
    return r && typeof r.summary === 'string' ? r : null
  } catch {
    return null
  }
}

/** "Fill it for me": the AI fills the form in Sidedoor's browser window and stops before submit. */
function FillForm({ d }: { d: Detail }) {
  const a = d.application
  const t = d.tasks.find((x) => x.kind === 'submit-assist')
  const fill = useAction((v: { kind: 'submit-assist'; applicationId: string }) => startTaskFn({ data: v }), { success: 'Opening the form on your computer…' })
  const active = t?.status === 'queued' || t?.status === 'running'
  const report = t?.status === 'done' ? parseReport(t.output) : null
  const start = () => void fill.run({ kind: 'submit-assist', applicationId: a.id })

  if (active)
    return (
      <div className="flex items-center gap-2 rounded-lg bg-muted/50 p-3 text-sm">
        <Loader2 className="size-4 animate-spin text-primary" />
        {t.status === 'queued' ? 'Waiting to start…' : 'Your AI is filling the form in the Sidedoor browser window. It stops before submit.'}
      </div>
    )

  return (
    <div className="space-y-2">
      {report && (
        <div className={cn('space-y-2 rounded-lg p-3 text-sm', report.outcome === 'ready' ? 'bg-success/10' : report.outcome === 'needs_you' ? 'bg-hot/10' : 'bg-destructive/10')}>
          <div className="font-medium">{report.outcome === 'ready' ? 'Filled. Review it in the browser window, then submit.' : report.outcome === 'needs_you' ? 'Mostly filled. A few things need you.' : 'Couldn’t fill the form.'}</div>
          <div className="text-muted-foreground">{report.summary}</div>
          {report.needsYou.length > 0 && (
            <ul className="space-y-1">
              {report.needsYou.map((n, i) => (
                <li key={i}>
                  <span className="font-medium">{n.field}</span> <span className="text-muted-foreground">: {n.why}</span>
                </li>
              ))}
            </ul>
          )}
          {report.filled.length > 0 && (
            <details>
              <summary className="cursor-pointer text-xs text-muted-foreground">{report.filled.length} fields filled</summary>
              <ul className="mt-1.5 space-y-0.5 text-xs">
                {report.filled.map((f, i) => (
                  <li key={i}>
                    <span className="text-muted-foreground">{f.field}:</span> {f.value}
                  </li>
                ))}
              </ul>
            </details>
          )}
        </div>
      )}
      {t?.status === 'failed' && <div className="rounded-lg bg-destructive/10 p-3 text-sm text-destructive">Form fill failed: {t.error}</div>}
      <div className="flex flex-wrap items-center gap-2">
        <Button size="sm" onClick={start} disabled={fill.pending || !(a.applyUrl || a.jobUrl)}>
          <WandSparkles /> {t ? 'Fill it again' : 'Fill it for me'}
        </Button>
        {!t && <span className="text-xs text-muted-foreground">Opens the form in a browser window on your computer and fills it. You review and submit.</span>}
      </div>
    </div>
  )
}

/** Sections that are reference, not review: folded so the package reads as the part to check. */
const REFERENCE = /^(facts used|submission notes|sources|notes for you|uploads)\b/i

/**
 * The package for reading: absolute file paths shown as their names (you open files from the
 * buttons above), and reference sections folded.
 */
function PackageText({ md }: { md: string }) {
  const tidy = md
    .replace(/`(?:[A-Za-z]:)?[\\/][^`]*[\\/]([^`\\/]+\.(?:pdf|md|html|docx?))`/g, '$1')
    // Not inside URLs: a path starts the word.
    .replace(/(?<![\w:/.\\(=-])(?:[A-Za-z]:)?[\\/](?:[^\s|)`]+[\\/])+([^\s|)`\\/]+\.(?:pdf|md|html|docx?))/g, '$1')
  const parts = tidy.split(/^(?=## )/m)
  return (
    <div className="space-y-2 rounded-xl border bg-card p-4">
      {parts.map((part, i) => {
        const title = part.match(/^## (.+)$/m)?.[1]?.trim() ?? ''
        if (!title || !REFERENCE.test(title)) return <Markdown key={i}>{part}</Markdown>
        return (
          <details key={i} className="group rounded-lg border px-3 py-2">
            <summary className="cursor-pointer list-none text-sm font-semibold">
              <ChevronDown className="mr-1 inline size-4 -rotate-90 text-muted-foreground transition-transform group-open:rotate-0" />
              {title}
            </summary>
            <div className="mt-2">
              <Markdown>{part.replace(/^## .+$/m, '')}</Markdown>
            </div>
          </details>
        )
      })}
    </div>
  )
}

/** Prepared work whose listing disappeared: check before spending more on it. */
function ListingGone({ d }: { d: Detail }) {
  const qc = useQueryClient()
  const stage = useAction((v: { id: string; stage: Stage; closedReason?: string }) => setStageFn({ data: v }))
  const posting = d.posting
  if (!posting?.closedAt) return null
  const reopen = async () => {
    await rpc.listingStillOpen({ postingId: posting.id })
    await qc.invalidateQueries({ queryKey: ['application', d.application.id] })
  }
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-2 rounded-lg bg-destructive/10 px-3 py-2 text-sm">
      <span className="min-w-0 flex-1 basis-64">
        <span className="font-medium">The listing was taken down {fmtDate(posting.closedAt)}.</span> Check the company’s site before you submit.
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

/** The one thing to do next, by stage. */
function NextStep({ d }: { d: Detail }) {
  const a = d.application
  const chat = useChat()
  // Entering Interviewing queues a prep brief (saved as research).
  const brief = d.research.find((r) => /^interview prep/i.test(r.title))
  const stage = useAction((v: { id: string; stage: Stage; closedReason?: string; won?: boolean; note?: string }) => setStageFn({ data: v }))
  const task = useAction((v: { kind: 'research' | 'prep' | 'outreach'; applicationId: string; instructions?: string }) => startTaskFn({ data: v }), { success: 'Queued. You’ll get a notification when it’s done.' })
  const changes = useAction((v: { id: string; notes: string }) => requestChangesFn({ data: v }), { success: 'Sent back to your AI with your notes' })
  const [notes, setNotes] = useState('')
  const [showChanges, setShowChanges] = useState(false)
  const [confirmApprove, setConfirmApprove] = useState(false)
  const openDecisions = decisionsOf(a.packageMd).filter((x) => !x.done).length
  const pdf = fileUrl(d.resume?.pdfFile)
  const box = 'rounded-xl border bg-card p-4 space-y-3'

  // While your AI prepares the package (or revises it with your notes), that's the whole next step.
  const prep = d.tasks.find((t) => t.kind === 'prep' && (t.status === 'queued' || t.status === 'running'))
  if (prep && (a.stage === 'interested' || a.stage === 'review'))
    return (
      <div className={cn(box, 'text-sm text-muted-foreground')}>
        {prep.status === 'queued' && 'Waiting for your AI. '}
        {prep.input.revision === true ? 'Your AI is revising the package with your notes.' : 'Your AI is tailoring your resume and drafting answers.'} You’ll get a notification when it’s ready to review.
      </div>
    )

  switch (a.stage) {
    case 'interested':
      return (
        <div className={box}>
          <div className="text-sm">{a.nextAction ?? 'Decide whether to go after this one.'}</div>
          <div className="flex flex-wrap gap-2">
            <Button onClick={() => void task.run({ kind: 'prep', applicationId: a.id })} disabled={task.pending}>
              <FileText /> Prepare application
            </Button>
            <Button variant="secondary" onClick={() => void task.run({ kind: 'research', applicationId: a.id })} disabled={task.pending}>
              <UserSearch /> Find the hiring manager
            </Button>
            <Button variant="ghost" onClick={() => void stage.run({ id: a.id, stage: 'closed', closedReason: 'Not interested' })}>
              <ThumbsDown /> Pass
            </Button>
          </div>
        </div>
      )
    case 'review':
      return (
        <div className={cn(box, 'border-primary/40')}>
          <ListingGone d={d} />
          <div className="text-sm font-medium">
            {confirmApprove ? `${openDecisions} decision${openDecisions === 1 ? ' is' : 's are'} still open below. Approve without settling ${openDecisions === 1 ? 'it' : 'them'}?` : 'Review the package below, then approve or send it back.'}
          </div>
          <div className="flex flex-wrap gap-2">
            {confirmApprove ? (
              <>
                <Button onClick={() => void stage.run({ id: a.id, stage: 'approved' })} disabled={stage.pending}>
                  <CheckCircle2 /> Approve anyway
                </Button>
                <Button variant="ghost" onClick={() => setConfirmApprove(false)}>
                  Not yet
                </Button>
              </>
            ) : (
              <Button
                onClick={() => (openDecisions ? setConfirmApprove(true) : void stage.run({ id: a.id, stage: 'approved' }))}
                disabled={stage.pending}
                variant={d.posting?.closedAt ? 'outline' : 'default'}
              >
                <CheckCircle2 /> Approve
              </Button>
            )}
            <Button variant="outline" onClick={() => setShowChanges(!showChanges)}>
              <Pencil /> Request changes
            </Button>
            {pdf && (
              <Button asChild variant="outline">
                <a href={pdf} target="_blank" rel="noreferrer">
                  <FileText /> Resume PDF
                </a>
              </Button>
            )}
            {d.resume && (
              <Button asChild variant="outline">
                <Link to="/resume/$id" params={{ id: d.resume.id }}>
                  Edit resume
                </Link>
              </Button>
            )}
          </div>
          {showChanges && (
            <div className="space-y-2">
              <Textarea value={notes} onChange={(e) => setNotes(e.target.value)} rows={4} placeholder="e.g. Lead with the platform migration, put my salary answer at 180K, drop the cover letter…" />
              <Button size="sm" disabled={!notes.trim() || changes.pending} onClick={async () => { await changes.run({ id: a.id, notes }); setNotes(''); setShowChanges(false) }}>
                Send to your AI
              </Button>
            </div>
          )}
        </div>
      )
    case 'approved':
      return (
        <div className={cn(box, 'border-hot/40')}>
          <ListingGone d={d} />
          <div className="text-sm font-medium">Submit it</div>
          <FillForm d={d} />
          <ol className="space-y-2 text-sm">
            <li className="flex flex-wrap items-center gap-2">
              <span className="text-muted-foreground">1.</span>
              {a.applyUrl || a.jobUrl ? (
                <Button asChild size="sm">
                  <a href={(a.applyUrl ?? a.jobUrl)!} target="_blank" rel="noreferrer">
                    <ExternalLink /> Open application form
                  </a>
                </Button>
              ) : (
                <span>No apply URL saved.</span>
              )}
            </li>
            <li className="flex flex-wrap items-center gap-2">
              <span className="text-muted-foreground">2.</span>
              {pdf ? (
                <Button asChild size="sm" variant="outline">
                  <a href={pdf} download>
                    <FileText /> Download tailored resume
                  </a>
                </Button>
              ) : (
                <span>No tailored PDF; use your main resume.</span>
              )}
            </li>
            <li className="flex flex-wrap items-center gap-2">
              <span className="text-muted-foreground">3.</span> Copy answers from the Package tab below.
            </li>
            <li className="flex flex-wrap items-center gap-2">
              <span className="text-muted-foreground">4.</span>
              <Button size="sm" variant="secondary" onClick={() => void stage.run({ id: a.id, stage: 'applied' })} disabled={stage.pending}>
                <Send /> I submitted it
              </Button>
            </li>
          </ol>
        </div>
      )
    case 'applied':
    case 'screening':
    case 'interviewing':
    case 'offer':
      return (
        <div className={box}>
          <div className="flex flex-wrap items-center gap-2 text-sm">
            <span className="min-w-0 flex-1">{a.nextAction ?? 'Waiting to hear back.'}</span>
            <FollowupPicker date={a.nextActionDate} applicationId={a.id} />
          </div>
          <div className="flex flex-wrap gap-1.5">
            {a.stage === 'applied' && (
              <Button size="sm" variant="secondary" onClick={() => void stage.run({ id: a.id, stage: 'screening', note: 'Recruiter reached out' })}>
                Recruiter reached out
              </Button>
            )}
            {(a.stage === 'applied' || a.stage === 'screening') && (
              <Button size="sm" variant="secondary" onClick={() => void stage.run({ id: a.id, stage: 'interviewing' })}>
                Interviews scheduled
              </Button>
            )}
            {a.stage === 'interviewing' && (
              <Button size="sm" variant="secondary" onClick={() => void stage.run({ id: a.id, stage: 'offer' })}>
                <PartyPopper /> Got an offer
              </Button>
            )}
            {a.stage === 'offer' && (
              <Button size="sm" onClick={() => void stage.run({ id: a.id, stage: 'closed', won: true, closedReason: 'Accepted offer' })}>
                Accepted!
              </Button>
            )}
            <Button size="sm" variant="ghost" onClick={() => void stage.run({ id: a.id, stage: 'closed', closedReason: 'Rejected' })}>
              Rejected
            </Button>
            <Button size="sm" variant="ghost" onClick={() => void task.run({ kind: 'outreach', applicationId: a.id, instructions: 'Write follow-up messages: I applied and have not heard back. Add something new and useful.' })}>
              <Mail /> Draft follow-ups
            </Button>
            {(a.stage === 'screening' || a.stage === 'interviewing') &&
              (brief ? (
                <Button asChild size="sm" variant="ghost">
                  <Link to="/applications/$id" params={{ id: a.id }} search={{ tab: 'research' }}>
                    <FileText /> Open prep brief
                  </Link>
                </Button>
              ) : (
                <Button size="sm" variant="ghost" onClick={() => chat.openChat({ newThread: true, send: 'Help me prepare for my next interview for this role: likely questions, my best stories from my career inventory, and smart questions to ask.' })}>
                  <Bot /> Interview prep
                </Button>
              ))}
          </div>
        </div>
      )
    default:
      return (
        <div className={cn(box, 'text-sm text-muted-foreground')}>
          Closed{a.closedReason ? `: ${a.closedReason}` : ''}.{' '}
          <button type="button" className="text-primary" onClick={() => void stage.run({ id: a.id, stage: 'interested' })}>
            Reopen
          </button>
        </div>
      )
  }
}

function PackageTab({ d }: { d: Detail }) {
  const a = d.application
  const [editing, setEditing] = useState(false)
  const [md, setMd] = useState(a.packageMd ?? '')
  const save = useAction((v: { id: string; packageMd: string }) => updateApplicationFn({ data: { id: v.id, patch: { packageMd: v.packageMd } } }), { success: 'Saved' })
  const task = useAction((v: { kind: 'prep'; applicationId: string }) => startTaskFn({ data: v }), { success: 'Your AI is preparing it' })
  if (!a.packageMd)
    return (
      <Empty>
        No application package yet.{' '}
        <button type="button" className="text-primary" onClick={() => void task.run({ kind: 'prep', applicationId: a.id })}>
          Have your AI prepare one
        </button>
        .
      </Empty>
    )
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap gap-2">
        {/* In review, the next-step box above already has these. */}
        {a.stage !== 'review' && d.resume?.pdfFile && (
          <Button asChild size="sm" variant="outline">
            <a href={fileUrl(d.resume.pdfFile)!} target="_blank" rel="noreferrer">
              <FileText /> Resume PDF
            </a>
          </Button>
        )}
        {a.stage !== 'review' && d.resume && (
          <Button asChild size="sm" variant="outline">
            <Link to="/resume/$id" params={{ id: d.resume.id }}>
              Edit resume
            </Link>
          </Button>
        )}
        <CopyButton text={a.packageMd} label="Copy all" className="h-8" />
        <Button size="sm" variant="ghost" className="h-8" onClick={() => setEditing(!editing)}>
          <Pencil /> {editing ? 'Preview' : 'Edit'}
        </Button>
      </div>
      {!editing && <Decisions d={d} />}
      {!editing && <WritingCheck d={d} />}
      {editing ? (
        <div className="space-y-2">
          <Textarea value={md} onChange={(e) => setMd(e.target.value)} rows={24} className="font-mono text-xs" />
          <Button size="sm" onClick={async () => { await save.run({ id: a.id, packageMd: md }); setEditing(false) }}>
            Save
          </Button>
        </div>
      ) : (
        <PackageText md={withoutDecisions(a.packageMd)} />
      )}
    </div>
  )
}

/** The posting's requirements against the resume (the tailored one once prep has made it). */
function MatchTab({ d }: { d: Detail }) {
  const a = d.application
  const check = useAction((v: { kind: 'match'; applicationId: string }) => startTaskFn({ data: v }), { success: 'Checking the resume against the posting' })
  const running = d.tasks.some((t) => t.kind === 'match' && (t.status === 'queued' || t.status === 'running'))
  const failed = d.tasks.find((t) => t.kind === 'match')
  const recheck = () => void check.run({ kind: 'match', applicationId: a.id })
  const m = a.matchJson
  if (!m)
    return (
      <Empty>
        {running ? (
          <span className="inline-flex items-center gap-2">
            <Loader2 className="size-4 animate-spin text-primary" /> Your AI is reading the posting and your resume…
          </span>
        ) : (
          <div className="space-y-3">
            <div>See each thing the posting asks for, how well {d.resume ? 'the tailored resume' : 'your main resume'} answers it, and the line that does.</div>
            {failed?.status === 'failed' && <div className="text-destructive">Last check failed: {failed.error}</div>}
            <Button size="sm" onClick={recheck} disabled={check.pending}>
              <ListChecks /> Check resume match
            </Button>
          </div>
        )}
      </Empty>
    )
  return (
    <div className="space-y-4">
      <MatchSummary
        match={m}
        stale={d.matchStale}
        running={running || check.pending}
        onRecheck={recheck}
        actions={
          d.resume && m.doc === d.resume.id ? (
            <Button asChild size="sm" variant="outline" className="h-7 text-xs">
              <Link to="/resume/$id" params={{ id: d.resume.id }}>
                <Pencil /> Edit resume with match
              </Link>
            </Button>
          ) : !d.resume ? (
            <span className="text-xs text-muted-foreground">Checked against your main resume (no tailored one yet).</span>
          ) : null
        }
      />
      <MatchList match={m} />
    </div>
  )
}

/** Cover letter + free-text answers: editor-pass result, AI-tell score and flagged phrases for each. */
function WritingCheck({ d }: { d: Detail }) {
  const a = d.application
  const sections = useMemo(() => extractProseSections(a.packageMd), [a.packageMd])
  const ed = a.editorJson
  const run = useAction((v: { id: string }) => editPackageFn({ data: v }), { success: (r) => `Editor pass done: ${r.edited} section(s) edited` })
  const save = useAction((v: { id: string; packageMd: string }) => updateApplicationFn({ data: { id: v.id, patch: { packageMd: v.packageMd } } }), { success: 'Switched to the original' })
  if (!sections.length && !ed?.error) return null
  return (
    <Section
      title="Writing check"
      count={sections.length}
      action={
        <Button size="sm" variant="ghost" className="h-7 text-xs" disabled={run.pending} onClick={() => void run.run({ id: a.id })} title="Second AI pass against your writing style">
          {run.pending ? <Loader2 className="animate-spin" /> : <WandSparkles />} {ed && !ed.error ? 'Re-run editor' : 'Editor pass'}
        </Button>
      }
    >
      <div className="px-1 text-xs text-muted-foreground">
        {ed?.error ? <span className="text-destructive">Editor pass failed: {ed.error}</span> : ed ? <>Edited by {ed.model} <TimeAgo iso={ed.at} />. Showing the edited text; switch to Original or Changes to compare.</> : 'No editor pass yet.'}
      </div>
      <div className="space-y-2">
        {sections.map((s) => {
          const item = ed?.items.find((x) => x.key === s.key)
          return (
            <div key={s.key} className="rounded-xl border bg-card p-3.5">
              <div className="mb-2 flex items-start gap-2">
                <div className="min-w-0 flex-1 text-sm font-medium">{s.title}</div>
                <CopyButton text={s.text} className="h-7" />
              </div>
              <WritingReview
                current={s.text}
                original={item?.original}
                changes={item?.changes}
                rejected={item?.rejected}
                actions={(view) =>
                  view === 'original' && item && item.original !== s.text ? (
                    <Button size="sm" variant="ghost" className="h-7 text-xs" disabled={save.pending} onClick={() => void save.run({ id: a.id, packageMd: replaceSections(a.packageMd ?? '', { [s.key]: item.original }) })}>
                      <Undo2 /> Use original
                    </Button>
                  ) : null
                }
              />
            </div>
          )
        })}
      </div>
    </Section>
  )
}

function PeopleTab({ d }: { d: Detail }) {
  const a = d.application
  const [adding, setAdding] = useState(false)
  const task = useAction((v: { kind: 'research' | 'outreach'; applicationId: string }) => startTaskFn({ data: v }), { success: 'Queued' })
  const drafts = d.drafts.filter((x) => x.status === 'draft')
  const unassigned = drafts.filter((x) => !d.people.some((p) => p.id === x.personId))
  const recipients = d.people.map((p) => ({ id: p.id, name: p.name }))
  return (
    <div className="space-y-6">
      <div className="flex flex-wrap gap-2">
        <Button size="sm" variant="secondary" onClick={() => void task.run({ kind: 'research', applicationId: a.id })}>
          <Search /> Find people + emails
        </Button>
        <Button size="sm" variant="secondary" disabled={!d.people.length} onClick={() => void task.run({ kind: 'outreach', applicationId: a.id })}>
          <Mail /> Draft outreach
        </Button>
        <Button size="sm" variant="outline" onClick={() => setAdding(true)}>
          <Plus /> Add person
        </Button>
      </div>
      <Section title={`People at ${d.application.companyName}`}>
        {d.people.length ? (
          <div className="space-y-2">
            {d.people.map((p) => {
              const theirs = drafts.filter((x) => x.personId === p.id)
              return (
                <div key={p.id}>
                  <PersonRow p={p} extra={p.role ? <span className="text-xs text-muted-foreground">{roleLabel(p.role)}</span> : undefined} />
                  {p.whyMd && <div className="mx-3 mt-1 line-clamp-3 text-xs text-muted-foreground">{p.whyMd.replace(/[*#]/g, '')}</div>}
                  {/* Their drafts sit under them, so "I sent it" can't be credited to the wrong person. */}
                  {theirs.length > 0 && (
                    <div className="mt-2 ml-3 space-y-2 border-l-2 border-primary/30 pl-3">
                      {theirs.map((x) => (
                        <DraftCard key={x.id} d={x} people={recipients} />
                      ))}
                    </div>
                  )}
                </div>
              )
            })}
          </div>
        ) : (
          <Empty>No one linked yet. “Find people + emails” has your AI identify the hiring manager, recruiter and team.</Empty>
        )}
      </Section>
      {unassigned.length > 0 && (
        <Section title="Drafts without a recipient" count={unassigned.length}>
          <div className="space-y-2">
            {unassigned.map((x) => (
              <DraftCard key={x.id} d={x} people={recipients} />
            ))}
          </div>
        </Section>
      )}
      <PersonDialog open={adding} onOpenChange={setAdding} applicationId={a.id} initial={{ companyName: a.companyName }} />
    </div>
  )
}

function ResearchTab({ d }: { d: Detail }) {
  const task = useAction((v: { kind: 'research'; applicationId: string }) => startTaskFn({ data: v }), { success: 'Your AI is researching' })
  if (!d.research.length)
    return (
      <Empty>
        No research yet.{' '}
        <button type="button" className="text-primary" onClick={() => void task.run({ kind: 'research', applicationId: d.application.id })}>
          Research {d.application.companyName}
        </button>
      </Empty>
    )
  return (
    <div className="space-y-4">
      {d.research.map((r) => (
        <div key={r.id} className="rounded-xl border bg-card p-4">
          <div className="mb-2 flex items-center gap-2 text-xs text-muted-foreground">
            <span className="font-medium text-foreground">{r.title}</span> · <TimeAgo iso={r.createdAt} />
          </div>
          <Markdown>{r.bodyMd}</Markdown>
        </div>
      ))}
    </div>
  )
}

function TimelineTab({ d }: { d: Detail }) {
  const a = d.application
  return (
    <div className="space-y-6">
      <InteractionForm applicationId={a.id} />
      <div className="space-y-2">
        {d.interactions.map((i) => (
          <div key={i.id} className="flex gap-3 rounded-lg border bg-card px-3 py-2 text-sm">
            <span className="w-20 shrink-0 text-xs text-muted-foreground">{fmtDate(i.at)}</span>
            <span className="shrink-0 text-xs text-muted-foreground">{i.direction === 'in' ? '←' : i.direction === 'out' ? '→' : '•'} {i.channel}</span>
            <span className="min-w-0">{i.summary}</span>
          </div>
        ))}
        {d.tasks.map((t) => (
          <Link key={t.id} to="/tasks" className="flex gap-3 rounded-lg border border-dashed px-3 py-2 text-sm text-muted-foreground hover:text-foreground">
            <span className="w-20 shrink-0 text-xs">{fmtDate(t.createdAt)}</span>
            <Bot className="size-3.5 shrink-0" />
            <span className="min-w-0 truncate">
              {t.title} ({t.status})
            </span>
          </Link>
        ))}
      </div>
      {a.notesMd && (
        <Section title="Notes">
          <div className="rounded-xl border bg-card p-4">
            <Markdown>{a.notesMd}</Markdown>
          </div>
        </Section>
      )}
    </div>
  )
}

function DetailsTab({ d }: { d: Detail }) {
  const a = d.application
  const [v, setV] = useState({
    companyName: a.companyName,
    role: a.role,
    priority: a.priority,
    status: a.status,
    nextAction: a.nextAction ?? '',
    nextActionDate: a.nextActionDate ?? '',
    jobUrl: a.jobUrl ?? '',
    applyUrl: a.applyUrl ?? '',
    location: a.location ?? '',
    compText: a.compText ?? '',
  })
  const save = useAction((p: typeof v) => updateApplicationFn({ data: { id: a.id, patch: { ...p, nextAction: p.nextAction || null, nextActionDate: p.nextActionDate || null, jobUrl: p.jobUrl || null, applyUrl: p.applyUrl || null, location: p.location || null, compText: p.compText || null } } }), { success: 'Saved' })
  const f = (k: keyof typeof v) => ({ value: v[k], onChange: (e: { target: { value: string } }) => setV({ ...v, [k]: e.target.value }) })
  return (
    <div className="space-y-4">
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <div className="space-y-1.5">
          <Label>Company</Label>
          <Input {...f('companyName')} />
        </div>
        <div className="space-y-1.5">
          <Label>Role</Label>
          <Input {...f('role')} />
        </div>
        <div className="space-y-1.5">
          <Label>Priority</Label>
          <Select value={v.priority} onValueChange={(p) => setV({ ...v, priority: p as typeof v.priority })}>
            <SelectTrigger className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="high">High</SelectItem>
              <SelectItem value="medium">Medium</SelectItem>
              <SelectItem value="low">Low</SelectItem>
            </SelectContent>
          </Select>
        </div>
        <div className="space-y-1.5">
          <Label>Status</Label>
          <Select value={v.status} onValueChange={(p) => setV({ ...v, status: p as typeof v.status })}>
            <SelectTrigger className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {['potential', 'active', 'on-hold', 'closed-won', 'closed-lost'].map((s) => (
                <SelectItem key={s} value={s}>
                  {s}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="space-y-1.5 sm:col-span-2">
          <Label>Next action</Label>
          <Input {...f('nextAction')} />
        </div>
        <div className="space-y-1.5">
          <Label>Next action date</Label>
          <Input type="date" {...f('nextActionDate')} />
        </div>
        <div className="space-y-1.5">
          <Label>Compensation</Label>
          <Input {...f('compText')} />
        </div>
        <div className="space-y-1.5 sm:col-span-2">
          <Label>Location</Label>
          <Input {...f('location')} />
        </div>
        <div className="space-y-1.5 sm:col-span-2">
          <Label>Job URL</Label>
          <Input {...f('jobUrl')} />
        </div>
        <div className="space-y-1.5 sm:col-span-2">
          <Label>Apply URL</Label>
          <Input {...f('applyUrl')} />
        </div>
      </div>
      <Button onClick={() => void save.run(v)} disabled={save.pending}>
        Save
      </Button>
      {d.otherApplications.length > 0 && (
        <Section title={`Other applications at ${a.companyName}`}>
          <div className="space-y-1.5">
            {d.otherApplications.map((o) => (
              <Link key={o.id} to="/applications/$id" params={{ id: o.id }} className="flex items-center justify-between gap-2 rounded-lg border bg-card px-3 py-2 text-sm">
                <span className="truncate">{o.role}</span>
                <StageBadge stage={o.stage} />
              </Link>
            ))}
          </div>
        </Section>
      )}
      <div className="text-xs text-muted-foreground">
        Added {fmtDate(a.createdAt)} · last activity <TimeAgo iso={a.lastActivityAt} />
        {a.nextActionDate && (
          <>
            {' '}
            · next <Due date={a.nextActionDate} />
          </>
        )}
      </div>
    </div>
  )
}

/**
 * The package's "Needs your decision" items. Each is fine as is or gets your answer; answers are
 * kept in the package and go to your AI together, as one revision.
 */
function Decisions({ d }: { d: Detail }) {
  const a = d.application
  const items = decisionsOf(a.packageMd)
  const qc = useQueryClient()
  const [answering, setAnswering] = useState<string | null>(null)
  const [answer, setAnswer] = useState('')
  const changes = useAction((v: { id: string; notes: string }) => requestChangesFn({ data: v }), { success: 'Sent to your AI. It’s revising the package with your answers.' })
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

