import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Link } from '@tanstack/react-router'
import { Loader2 } from 'lucide-react'
import { useEffect, useState } from 'react'
import { toast } from 'sonner'
import { timeAgo } from '@sidedoor/shared/format'
import { Badge } from '~/components/ui/badge'
import { Button } from '~/components/ui/button'
import { Textarea } from '~/components/ui/textarea'
import { qo, rpc } from '~/lib/api'

type Report = NonNullable<Awaited<ReturnType<typeof rpc.submitBatch>>>
type Item = Report['items'][number]

const LABEL: Record<Item['status'], string> = {
  pending: 'Waiting',
  queued: 'Queued',
  filling: 'Filling',
  submitted: 'Submitted',
  ready: 'Ready (dry run)',
  filled: 'Filled, for you',
  questions: 'Needs answers',
  blocked: 'Blocked',
  not_submitted: 'Not submitted',
  failed: 'Failed',
  cancelled: 'Cancelled',
}
const MODE = { 'dry-run': 'Dry run', fill: 'Fill only', submit: 'Submit' } as const

const tone = (s: Item['status']) =>
  s === 'submitted' || s === 'ready' || s === 'filled' ? 'secondary' : s === 'failed' || s === 'not_submitted' ? 'destructive' : s === 'blocked' || s === 'questions' ? 'default' : 'outline'

/** Grok Bot's latest submit batch: one line per application, and pause, resume or cancel. */
export function SubmitBatchCard() {
  const qc = useQueryClient()
  const { data: b } = useQuery(qo.submitBatch())
  const [busy, setBusy] = useState<string | null>(null)
  if (!b) return null
  const steer = async (action: 'pause' | 'resume' | 'cancel') => {
    setBusy(action)
    try {
      await rpc.steerSubmitBatch({ id: b.id, action })
      await qc.invalidateQueries({ queryKey: ['grokBot'] })
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(null)
    }
  }
  const open = b.status === 'running' || b.status === 'paused'
  const counts = Object.entries(b.counts)
    .map(([k, n]) => `${n} ${LABEL[k as Item['status']].toLowerCase()}`)
    .join(' · ')
  return (
    <div className="mt-3 space-y-2 border-t pt-3 text-sm">
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-medium">
          {MODE[b.mode]} batch · {b.items.length} application{b.items.length === 1 ? '' : 's'}
        </span>
        <span className="text-xs text-muted-foreground">
          {b.status} · started {timeAgo(b.createdAt)}
        </span>
        <div className="ml-auto flex gap-1">
          {b.status === 'running' && (
            <Button size="sm" variant="ghost" disabled={!!busy} onClick={() => void steer('pause')}>
              {busy === 'pause' && <Loader2 className="animate-spin" />} Pause
            </Button>
          )}
          {b.status === 'paused' && (
            <Button size="sm" variant="ghost" disabled={!!busy} onClick={() => void steer('resume')}>
              {busy === 'resume' && <Loader2 className="animate-spin" />} Resume
            </Button>
          )}
          {open && (
            <Button size="sm" variant="ghost" disabled={!!busy} onClick={() => void steer('cancel')}>
              {busy === 'cancel' && <Loader2 className="animate-spin" />} Cancel
            </Button>
          )}
        </div>
      </div>
      {b.note && <p className="text-xs text-hot">{b.note}</p>}
      <p className="text-xs text-muted-foreground">{counts}</p>
      <ol className="max-h-80 space-y-1.5 overflow-auto">
        {b.items.map((i) => (
          <li key={i.applicationId} className="flex items-start gap-2">
            <span className="w-5 shrink-0 text-right text-xs text-muted-foreground">{i.position}</span>
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-center gap-2">
                <Link to="/applications/$id" params={{ id: i.applicationId }} className="truncate hover:underline">
                  {i.application}
                </Link>
                <Badge variant={tone(i.status)}>
                  {LABEL[i.status]}
                  {i.blockedBy ? `: ${i.blockedBy}` : ''}
                </Badge>
              </div>
              {i.status !== 'pending' && <p className="text-xs text-muted-foreground">{i.summary}</p>}
              {i.questions.length > 0 && (
                <ul className="list-disc pl-4 text-xs text-muted-foreground">
                  {i.questions.map((q) => (
                    <li key={q.question}>
                      {q.question}
                      {q.options.length ? ` (${q.options.join(' / ')})` : ''}
                    </li>
                  ))}
                </ul>
              )}
              {i.evidence && (
                <p className="text-xs text-muted-foreground">
                  Confirmation: {i.evidence.title ?? i.evidence.url ?? 'page read'}
                  {i.evidence.reported ? ` · “${i.evidence.reported}”` : ''}
                </p>
              )}
            </div>
          </li>
        ))}
      </ol>
    </div>
  )
}

/** "Acme 3/60" per line: at most 3 applications to Acme in 60 days. "* 2/30" is everyone else. */
const parseLimits = (text: string) =>
  text
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => {
      const m = l.match(/^(.+?)\s+(\d+)\s*\/\s*(\d+)\s*(?:days?|d)?$/i)
      if (!m) throw new Error(`“${l}”: write it as “Company 3/60” (3 applications in 60 days)`)
      return { company: m[1]!.trim(), max: Number(m[2]), days: Number(m[3]) }
    })

export function CompanyLimits({ limits, onSave }: { limits: { company: string; max: number; days: number }[]; onSave: (l: ReturnType<typeof parseLimits>) => Promise<unknown> }) {
  const shown = limits.map((l) => `${l.company} ${l.max}/${l.days}`).join('\n')
  const [text, setText] = useState(shown)
  useEffect(() => setText(shown), [shown])
  return (
    <div className="space-y-2">
      <Textarea rows={3} value={text} onChange={(e) => setText(e.target.value)} placeholder={'Acme 3/60\n* 2/30'} className="font-mono text-xs" />
      <div className="flex justify-end">
        <Button
          size="sm"
          variant="outline"
          disabled={text === shown}
          onClick={() => {
            try {
              void onSave(parseLimits(text))
            } catch (e) {
              toast.error(e instanceof Error ? e.message : String(e))
            }
          }}
        >
          Save limits
        </Button>
      </div>
    </div>
  )
}
