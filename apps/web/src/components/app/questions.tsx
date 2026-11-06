import { Link } from '@tanstack/react-router'
import { Check, Circle, X } from 'lucide-react'
import { useState } from 'react'
import { TimeAgo } from '~/components/app/bits'
import { Badge } from '~/components/ui/badge'
import { Button } from '~/components/ui/button'
import { Checkbox } from '~/components/ui/checkbox'
import { Textarea } from '~/components/ui/textarea'
import { rpc } from '~/lib/api'
import { useAction } from '~/lib/use-action'
import { cn } from '~/lib/utils'

export type QuestionGroup = Awaited<ReturnType<typeof rpc.questions>>[number]

const BY: Record<string, string> = { you: 'You', grokbot: 'Grok Bot, from you', package: 'In the package', agent: 'Your AI, from you' }
const ASKED_BY: Record<string, string> = { prep: 'prep', tune: 'tuning', fill: 'the form', package: 'the package', agent: 'your AI' }
const KEPT_IN = { answers: 'Standard answers', experience: 'Experience' } as const

/**
 * Questions only you can answer, each answered right here. "For every application" keeps the
 * answer in Standard answers or Experience, answers the same question wherever it's open, and
 * means it isn't asked again.
 */
export function QuestionList({ groups, showApplications = true }: { groups: QuestionGroup[]; showApplications?: boolean }) {
  return (
    <ul className="divide-y rounded-xl border bg-card">
      {groups.map((g) => (
        <QuestionRow key={g.id} g={g} showApplications={showApplications} />
      ))}
    </ul>
  )
}

function QuestionRow({ g, showApplications }: { g: QuestionGroup; showApplications: boolean }) {
  const [editing, setEditing] = useState(false)
  const [answer, setAnswer] = useState(g.answer ?? '')
  const [forAll, setForAll] = useState(g.scope === 'global')
  const [saveTo, setSaveTo] = useState<'answers' | 'experience'>(g.saveTo ?? 'answers')
  const save = useAction((v: { answer: string }) => rpc.answerQuestion({ ids: forAll ? [g.id] : g.ids, answer: v.answer, allApplications: forAll, ...(forAll ? { saveTo } : {}) }), {
    success: (r) => (r.resubmitted.length ? 'Saved. Sidedoor is filling the form again for Grok Bot.' : forAll ? `Saved for every application, in ${KEPT_IN[saveTo]}` : 'Saved'),
  })
  const dismiss = useAction(() => rpc.dismissQuestion({ ids: g.ids }))
  const reopen = useAction(() => rpc.reopenQuestion({ id: g.id }))
  const open = g.status === 'open'
  const answering = open || editing
  const submit = async (text: string) => {
    if (!text.trim()) return
    await save.run({ answer: text })
    setEditing(false)
  }

  return (
    <li className="p-3.5">
      <div className="flex items-start gap-2.5 text-sm">
        <span className="mt-0.5 shrink-0">{g.status === 'answered' ? <Check className="size-4 text-success" /> : g.status === 'dismissed' ? <X className="size-4 text-muted-foreground" /> : <Circle className="size-4 text-muted-foreground" />}</span>
        <div className="min-w-0 flex-1 space-y-1">
          <div className={cn(g.status === 'dismissed' && 'text-muted-foreground line-through')}>{g.question}</div>
          {g.why && <div className="text-xs text-muted-foreground">{g.why}</div>}
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
            <Badge variant="outline" className="h-5 text-[11px]">{g.about === 'you' ? 'About you' : 'About this application'}</Badge>
            {showApplications &&
              g.applications.map((a) => (
                <Link key={a.id} to="/applications/$id" params={{ id: a.id }} className="underline-offset-2 hover:text-foreground hover:underline">
                  {a.name}
                </Link>
              ))}
            {!g.applications.length && <span>Any application</span>}
            <span>
              asked by {ASKED_BY[g.askedBy] ?? g.askedBy} <TimeAgo iso={g.askedAt} />
            </span>
          </div>
          {g.status === 'answered' && !editing && (
            <div className="pt-1">
              <div className="whitespace-pre-wrap">{g.answer}</div>
              <div className="mt-0.5 text-xs text-muted-foreground">
                {BY[g.answeredBy ?? ''] ?? `${g.answeredBy}, from you`} <TimeAgo iso={g.answeredAt} />
                {g.scope === 'global' ? ` · every application${g.saveTo ? `, kept in ${KEPT_IN[g.saveTo]}` : ''}` : ' · this application only'}
              </div>
            </div>
          )}
        </div>
        {!answering && (
          <div className="flex shrink-0 gap-1">
            {g.status === 'answered' && (
              <Button size="sm" variant="ghost" className="h-7 text-xs" onClick={() => { setAnswer(g.answer ?? ''); setEditing(true) }}>
                Edit
              </Button>
            )}
            <Button size="sm" variant="ghost" className="h-7 text-xs" disabled={reopen.pending} onClick={() => void reopen.run(undefined)}>
              Ask again
            </Button>
          </div>
        )}
      </div>
      {answering && (
        <div className="mt-2.5 space-y-2 pl-6.5">
          {g.options.length > 0 && (
            <div className="flex flex-wrap gap-1.5">
              {g.options.map((o) => (
                <Button key={o} size="sm" variant={answer === o ? 'secondary' : 'outline'} className="h-7 text-xs" disabled={save.pending} onClick={() => setAnswer(o)}>
                  {o}
                </Button>
              ))}
            </div>
          )}
          <Textarea value={answer} onChange={(e) => setAnswer(e.target.value)} rows={2} placeholder="Your answer, in your words" onKeyDown={(e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) void submit(answer) }} />
          <div className="flex flex-wrap items-center gap-x-3 gap-y-2 text-xs">
            <label className="flex items-center gap-1.5">
              <Checkbox checked={forAll} onCheckedChange={(v) => setForAll(v === true)} />
              Applies to all applications
            </label>
            {forAll && (
              <span className="flex items-center gap-1 text-muted-foreground">
                keep in
                {(['answers', 'experience'] as const).map((k) => (
                  <button key={k} type="button" onClick={() => setSaveTo(k)} className={cn('rounded px-1.5 py-0.5', saveTo === k ? 'bg-secondary font-medium text-foreground' : 'hover:text-foreground')}>
                    {KEPT_IN[k]}
                  </button>
                ))}
              </span>
            )}
            <div className="ml-auto flex gap-1">
              {editing ? (
                <Button size="sm" variant="ghost" className="h-7 text-xs" onClick={() => setEditing(false)}>
                  Cancel
                </Button>
              ) : (
                <Button size="sm" variant="ghost" className="h-7 text-xs" disabled={dismiss.pending} onClick={() => void dismiss.run(undefined)}>
                  Not needed
                </Button>
              )}
              <Button size="sm" className="h-7 text-xs" disabled={!answer.trim() || save.pending} onClick={() => void submit(answer)}>
                Save answer
              </Button>
            </div>
          </div>
          {g.ids.length > 1 && forAll && <div className="text-xs text-muted-foreground">Answers it for all {g.ids.length} applications that asked.</div>}
        </div>
      )}
    </li>
  )
}

/** On an application: its questions, and sending the new answers to the AI for a targeted update of the package. */
export function ApplicationQuestions({ applicationId, groups, hasPackage }: { applicationId: string; groups: QuestionGroup[]; hasPackage: boolean }) {
  const revise = useAction(() => rpc.reviseWithAnswers({ applicationId }), { success: 'Sent to your AI. It updates only what your answers change.' })
  const [showDone, setShowDone] = useState(false)
  const [showOptional, setShowOptional] = useState(false)
  const open = groups.filter((g) => g.status === 'open' && !g.optional)
  const optional = groups.filter((g) => g.status === 'open' && g.optional)
  const done = groups.filter((g) => g.status !== 'open')
  const fresh = groups.filter((g) => g.unrevised).length
  if (!groups.length) return null
  return (
    <section className="space-y-2">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2 px-1">
        <h3 className="text-sm font-semibold">{open.length ? `${open.length} question${open.length === 1 ? '' : 's'} for you` : optional.length ? 'No questions need you' : 'Questions answered'}</h3>
        {done.length > 0 && (
          <button type="button" className="text-xs text-muted-foreground hover:text-foreground" onClick={() => setShowDone(!showDone)}>
            {showDone ? 'Hide' : 'Show'} {done.length} answered
          </button>
        )}
        {optional.length > 0 && (
          <button type="button" className="text-xs text-muted-foreground hover:text-foreground" onClick={() => setShowOptional(!showOptional)}>
            {showOptional ? 'Hide' : 'Show'} {optional.length} optional
          </button>
        )}
        {hasPackage && fresh > 0 && (
          <Button size="sm" variant="outline" className="ml-auto h-7 text-xs" disabled={revise.pending} onClick={() => void revise.run(undefined)}>
            Update the package with {fresh} answer{fresh === 1 ? '' : 's'}
          </Button>
        )}
      </div>
      {(showDone ? open.length + done.length > 0 : open.length > 0) && <QuestionList groups={showDone ? [...open, ...done] : open} showApplications={false} />}
      {showOptional && (
        <>
          <p className="px-1 text-xs text-muted-foreground">These could strengthen it, but it can go without them.</p>
          <QuestionList groups={optional} showApplications={false} />
        </>
      )}
    </section>
  )
}
