import { ChevronDown } from 'lucide-react'
import { useMemo, useState } from 'react'
import { datedNotes, isLongNote, isOneLineNote, structureNote } from '@sidedoor/shared/notes'
import { fmtDate } from '@sidedoor/shared/format'
import { cn } from '~/lib/utils'
import { Markdown } from './bits'

/**
 * A long note an agent wrote (a call summary, company notes): labeled paragraphs get their label
 * as a small heading, line breaks are kept, and a long one shows its opening until you expand it.
 */
export function Note({ text, className }: { text: string; className?: string }) {
  const md = useMemo(() => structureNote(text), [text])
  const long = isLongNote(text)
  const [open, setOpen] = useState(false)
  const sections = (md.match(/^#### /gm) ?? []).length
  return (
    <div className={className}>
      <div className={cn(long && !open && 'max-h-48 overflow-hidden [mask-image:linear-gradient(to_bottom,black_55%,transparent)]')}>
        <Markdown breaks className="prose-note">
          {md}
        </Markdown>
      </div>
      {long && (
        <button type="button" onClick={() => setOpen(!open)} className="mt-1 inline-flex items-center gap-1 text-xs font-medium text-primary hover:underline">
          <ChevronDown className={cn('size-3.5 transition-transform', open && 'rotate-180')} />
          {open ? 'Show less' : sections > 1 ? `Show all ${sections} sections` : 'Show all'}
        </button>
      )}
    </div>
  )
}

const CHANNEL: Record<string, string> = { email: 'Email', linkedin: 'LinkedIn', call: 'Call', meeting: 'Meeting', text: 'Text', x: 'X', other: 'Other' }

type Interaction = { id: string; at: string; channel: string; direction: string; summary: string }

const arrow = (direction: string) => (direction === 'in' ? '←' : direction === 'out' ? '→' : '•')

/** One touchpoint in a history: a short one on a single row, a long one (a call's notes) as a card. */
export function Touchpoint({ i, who }: { i: Interaction; who?: string | null }) {
  if (isOneLineNote(i.summary))
    return (
      <div className="flex gap-3 rounded-lg border bg-card px-3 py-2 text-sm">
        <span className="w-16 shrink-0 text-xs text-muted-foreground">{fmtDate(i.at)}</span>
        <span className="w-20 shrink-0 text-xs text-muted-foreground">
          {arrow(i.direction)} {i.channel}
        </span>
        <span className="min-w-0">{i.summary}</span>
      </div>
    )
  return (
    <article className="rounded-xl border bg-card px-4 py-3">
      <header className="mb-1.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
        <span className={cn('rounded-full px-2 py-0.5 font-medium', i.channel === 'meeting' || i.channel === 'call' ? 'bg-primary/10 text-primary' : 'bg-muted text-foreground/80')}>
          {arrow(i.direction)} {CHANNEL[i.channel] ?? i.channel}
        </span>
        {who && <span className="font-medium text-foreground">{who}</span>}
        <span className="ml-auto tabular-nums">{fmtDate(i.at)}</span>
      </header>
      <Note text={i.summary} />
    </article>
  )
}

/**
 * Notes kept as appendNote's dated log, one entry per row with its date beside it, newest first.
 * Notes in any other shape are shown as written.
 */
export function NotesLog({ md }: { md: string }) {
  const entries = useMemo(() => datedNotes(md), [md])
  if (!entries) return <Note text={md} />
  return (
    <ol className="divide-y">
      {[...entries].reverse().map((e, n) => (
        <li key={entries.length - n} className="flex gap-3 py-2.5 first:pt-0 last:pb-0">
          <span className="w-16 shrink-0 pt-0.5 text-xs text-muted-foreground tabular-nums">{e.date ? fmtDate(e.date) : ''}</span>
          <Note text={e.body} className="min-w-0 flex-1" />
        </li>
      ))}
    </ol>
  )
}
