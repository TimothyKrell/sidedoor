import { useSuspenseQuery } from '@tanstack/react-query'
import { createFileRoute, Link } from '@tanstack/react-router'
import { ChevronRight, Loader2, Plus, RotateCw, X } from 'lucide-react'
import { type ReactNode, useState } from 'react'
import { Empty, Markdown, PageHeader, TimeAgo } from '~/components/app/bits'
import { Badge } from '~/components/ui/badge'
import { Button } from '~/components/ui/button'
import { Textarea } from '~/components/ui/textarea'
import { cancelTaskFn, type listTasksFn, qo, retryTaskFn, startTaskFn } from '~/lib/api'
import { useAction } from '~/lib/use-action'
import { cn } from '~/lib/utils'

export const Route = createFileRoute('/tasks')({
  loader: ({ context }) => context.queryClient.ensureQueryData(qo.tasks()),
  component: Tasks,
})

const KIND: Record<string, string> = {
  triage: 'Scoring',
  prep: 'Application package',
  research: 'Research',
  outreach: 'Outreach draft',
  discover: 'Discovery',
  funding: 'Funding radar',
  'resume-notes': 'Resume notes',
  match: 'Match check',
  'submit-assist': 'Form filling',
  'x-scout': 'X scout',
  'import-resume': 'Resume import',
  custom: 'Your request',
}

// Errors can carry terminal colour codes from the CLIs and browser tooling.
// biome-ignore lint/suspicious/noControlCharactersInRegex: matching escape codes is the point
const stripAnsi = (s: string) => s.replace(/\u001b\[[0-9;?]*[ -\/]*[@-~]/g, '')

/** The first readable sentence of an error, without stack frames or tool chatter. */
const headline = (err: string) => {
  const clean = stripAnsi(err).trim()
  if (/at mailto:/i.test(clean)) return 'This job takes applications by email, not a form, so there was nothing to fill.'
  const line = clean.split('\n').find((l) => l.trim() && !/^\s*at\s/.test(l)) ?? clean
  return line.replace(/^(Error|AgentError):\s*/, '').slice(0, 240)
}

type T = Awaited<ReturnType<typeof listTasksFn>>[number]

/** "Package: Wrapbook – Manager" from whatever the task was stored as ("Prep: …", "Prepare package: …"). */
const titleOf = (t: T) => {
  const subject = t.title.includes(': ') ? t.title.slice(t.title.indexOf(': ') + 2) : t.title
  const kind = KIND[t.kind]
  return kind && t.kind !== 'custom' ? `${kind}: ${subject}` : t.title
}
const byEmail = (t: T) => !!t.error && /at mailto:|takes applications by email/i.test(t.error)
const when = (t: T) => t.finishedAt ?? t.startedAt ?? t.createdAt

function TaskRow({ t }: { t: T }) {
  const [open, setOpen] = useState(t.status === 'failed')
  const retry = useAction((v: { id: string }) => retryTaskFn({ data: v }), { success: 'Re-queued' })
  const cancel = useAction((v: { id: string }) => cancelTaskFn({ data: v }))
  const dur = t.startedAt && t.finishedAt ? Math.round((new Date(t.finishedAt).getTime() - new Date(t.startedAt).getTime()) / 1000) : null
  return (
    <div className="rounded-xl border bg-card">
      <button type="button" onClick={() => setOpen(!open)} className="flex w-full items-center gap-3 px-3.5 py-2.5 text-left text-sm">
        {t.status === 'running' ? <Loader2 className="size-4 shrink-0 animate-spin text-info" /> : <ChevronRight className={cn('size-4 shrink-0 text-muted-foreground transition-transform', open && 'rotate-90')} />}
        <span className="min-w-0 flex-1">
          <span className="block truncate">{titleOf(t)}</span>
          {t.status === 'failed' && t.error && <span className={cn('block truncate text-xs', byEmail(t) ? 'text-muted-foreground' : 'text-destructive')}>{headline(t.error)}</span>}
        </span>
        {t.status === 'queued' && <span className="shrink-0 text-xs text-muted-foreground">Waiting</span>}
        {t.status === 'running' && t.provider === 'grokbot' && <span className="shrink-0 text-xs text-muted-foreground">Grok Bot is on it</span>}
        {t.status === 'cancelled' && <span className="shrink-0 text-xs text-muted-foreground">Stopped</span>}
        <TimeAgo iso={t.finishedAt ?? t.startedAt ?? t.createdAt} className="hidden shrink-0 text-xs text-muted-foreground sm:block" />
      </button>
      {open && (
        <div className="space-y-3 border-t px-3.5 py-3 text-sm">
          <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
            <Badge variant="outline">{KIND[t.kind] ?? t.kind}</Badge>
            {dur !== null && <span>{dur < 120 ? `${dur}s` : `${Math.round(dur / 60)} min`}</span>}
            {t.costUsd != null && <span>≈ ${t.costUsd.toFixed(2)} API-equivalent (on your subscription)</span>}
            {t.runAfter && t.status === 'queued' && <span>deferred until <TimeAgo iso={t.runAfter} /></span>}
            {t.applicationId && (
              <Link to="/applications/$id" params={{ id: t.applicationId }} className="text-primary">
                Open application
              </Link>
            )}
            {t.personId && (
              <Link to="/people/$id" params={{ id: t.personId }} className="text-primary">
                Open person
              </Link>
            )}
            <span className="ml-auto flex gap-1">
              {(t.status === 'failed' || t.status === 'done' || t.status === 'cancelled') && !byEmail(t) && (
                <Button size="sm" variant="outline" className="h-7" onClick={() => void retry.run({ id: t.id })}>
                  <RotateCw /> Run again
                </Button>
              )}
              {t.status === 'queued' && (
                <Button size="sm" variant="ghost" className="h-7" onClick={() => void cancel.run({ id: t.id })}>
                  <X /> Cancel
                </Button>
              )}
            </span>
          </div>
          {t.error && !byEmail(t) && stripAnsi(t.error).trim() !== headline(t.error) && (
            <details>
              <summary className="cursor-pointer text-xs text-muted-foreground">Error details</summary>
              <pre className="mt-2 max-h-72 overflow-auto rounded-md bg-muted/60 p-2 text-xs whitespace-pre-wrap text-muted-foreground">{stripAnsi(t.error)}</pre>
            </details>
          )}
          {t.output && <Markdown>{t.output}</Markdown>}
          {t.log && (
            <details>
              <summary className="cursor-pointer text-xs text-muted-foreground">Transcript</summary>
              <pre className="mt-2 max-h-96 overflow-auto rounded-md bg-muted/60 p-2 text-[11px] whitespace-pre-wrap text-muted-foreground">{t.log}</pre>
            </details>
          )}
        </div>
      )}
    </div>
  )
}

function Group({ title, count, children }: { title: string; count?: number; children: ReactNode }) {
  return (
    <section className="space-y-2">
      <h2 className="text-sm font-semibold">
        {title}
        {count ? <span className="ml-1.5 font-normal text-muted-foreground tabular-nums">{count}</span> : null}
      </h2>
      {children}
    </section>
  )
}

function Tasks() {
  const { data } = useSuspenseQuery(qo.tasks())
  const [text, setText] = useState('')
  const [show, setShow] = useState(false)
  const start = useAction((v: { kind: 'custom'; instructions: string }) => startTaskFn({ data: v }), { success: 'Queued. You’ll get a notification when it’s done.' })
  const [limit, setLimit] = useState(25)
  const sorted = [...data].sort((x, y) => when(y).localeCompare(when(x)))
  const active = sorted.filter((t) => t.status === 'running' || t.status === 'queued')
  // A failure that a later run of the same task fixed isn't worth your attention.
  const laterOk = (t: T) => data.some((x) => x.title === t.title && x.status === 'done' && x.createdAt > t.createdAt)
  const failed = sorted.filter((t) => t.status === 'failed' && !laterOk(t) && Date.now() - Date.parse(t.createdAt) < 14 * 86400_000)
  const shownFailed = new Set(failed.map((t) => t.id))
  const rest = sorted.filter((t) => t.status !== 'running' && t.status !== 'queued' && !shownFailed.has(t.id))
  return (
    <div className="space-y-6">
      <PageHeader
        title="AI tasks"
        subtitle="What your AI has been doing in the background."
        actions={
          <Button size="sm" variant="outline" onClick={() => setShow(!show)}>
            <Plus /> New task
          </Button>
        }
      />
      {show && (
        <div className="space-y-2 rounded-xl border bg-card p-3.5">
          <Textarea value={text} onChange={(e) => setText(e.target.value)} rows={3} placeholder="e.g. Find 10 Series A–C creative-AI companies hiring an EM in the US and add their job boards" autoFocus />
          <Button size="sm" disabled={!text.trim() || start.pending} onClick={async () => { await start.run({ kind: 'custom', instructions: text }); setText(''); setShow(false) }}>
            Start
          </Button>
        </div>
      )}
      {active.length > 0 && (
        <Group title="Working now" count={active.length}>
          {active.map((t) => (
            <TaskRow key={t.id} t={t} />
          ))}
        </Group>
      )}
      {failed.length > 0 && (
        <Group title="Didn’t finish" count={failed.length}>
          {failed.map((t) => (
            <TaskRow key={t.id} t={t} />
          ))}
        </Group>
      )}
      {data.length === 0 ? (
        <Empty>Nothing yet. Packages, research and drafts your AI works on show up here.</Empty>
      ) : (
        rest.length > 0 && (
          <Group title="Finished">
            {rest.slice(0, limit).map((t) => (
              <TaskRow key={t.id} t={t} />
            ))}
            {rest.length > limit && (
              <Button variant="ghost" size="sm" className="w-full" onClick={() => setLimit(limit + 50)}>
                Show more ({rest.length - limit})
              </Button>
            )}
          </Group>
        )
      )}
    </div>
  )
}
