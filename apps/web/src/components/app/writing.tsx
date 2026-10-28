import { useQuery } from '@tanstack/react-query'
import { ChevronRight, Highlighter } from 'lucide-react'
import { type ReactNode, useMemo, useState } from 'react'
import { qo } from '~/lib/api'
import { wordDiff } from '@sidedoor/shared/diff'
import { checkTellsWith, STRONG_WEIGHT, strongHits, type TellHit, type TellReport } from '@sidedoor/shared/tells'
import { cn } from '~/lib/utils'
import { Segmented } from './segmented'

export type EditorChange = { what: string; why: string }

/** Score text against the writing check rules (fetched once from the server, scoring done here, live). */
export function useTellReport(text: string | null | undefined): TellReport | null {
  const { data: rules } = useQuery(qo.tellRules())
  return useMemo(() => (rules && rules.length && text ? checkTellsWith(rules, text) : null), [rules, text])
}

const fmt = (n: number) => String(+n.toFixed(2))

/** "Sounds like AI": low with no strong tells, some with one or two, high beyond. Details on hover. */
export function TellScore({ report, was, className }: { report: TellReport | null; was?: TellReport | null; className?: string }) {
  if (!report) return null
  const strong = strongHits(report).length
  const tone = strong === 0 ? 'border-success/40 text-success' : strong <= 2 ? 'border-hot/40 text-hot' : 'border-destructive/50 text-destructive'
  return (
    <span
      className={cn('inline-flex items-center gap-1 rounded-md border px-2 py-0.5 text-xs font-medium whitespace-nowrap', tone, className)}
      title={`Writing check: score ${fmt(report.score)} (${report.per100} per 100 words), ${strong} strong phrase${strong === 1 ? '' : 's'} to fix${was && was.score !== report.score ? `; was ${fmt(was.score)} before editing` : ''}`}
    >
      Sounds like AI: {strong === 0 ? 'low' : strong <= 2 ? 'some' : 'high'}
    </span>
  )
}

/** Text with tell matches marked. Strong tells (weight >= 1) are underlined red, weak ones dotted. */
export function HighlightedText({ text, hits, className }: { text: string; hits: TellHit[] | null | undefined; className?: string }) {
  const parts = useMemo(() => {
    const spans = [...(hits ?? [])].filter((h) => h.end > h.start).sort((a, b) => a.start - b.start || b.end - a.end)
    const out: Array<{ text: string; hit?: TellHit; strong?: boolean }> = []
    let pos = 0
    for (const h of spans) {
      if (h.start < pos) {
        // Overlap (e.g. a triad inside a longer match): extend the previous mark if this one is stronger.
        const last = out[out.length - 1]
        if (last?.hit && h.end > pos) {
          last.text += text.slice(pos, h.end)
          last.strong = last.strong || h.weight >= STRONG_WEIGHT
          pos = h.end
        }
        continue
      }
      if (h.start > pos) out.push({ text: text.slice(pos, h.start) })
      out.push({ text: text.slice(h.start, h.end), hit: h, strong: h.weight >= STRONG_WEIGHT })
      pos = h.end
    }
    if (pos < text.length) out.push({ text: text.slice(pos) })
    return out
  }, [text, hits])
  return (
    <div className={cn('text-[13px] whitespace-pre-wrap break-words text-foreground/85', className)}>
      {parts.map((p, i) =>
        p.hit ? (
          <mark
            key={i}
            title={`${p.hit.label}: ${p.hit.fix}`}
            className={cn('rounded-sm bg-transparent text-inherit underline underline-offset-2', p.strong ? 'bg-destructive/10 decoration-destructive decoration-2' : 'decoration-muted-foreground/60 decoration-dotted')}
          >
            {p.text}
          </mark>
        ) : (
          <span key={i}>{p.text}</span>
        ),
      )}
    </div>
  )
}

function Disclosure({ label, children, defaultOpen = false }: { label: ReactNode; children: ReactNode; defaultOpen?: boolean }) {
  const [open, setOpen] = useState(defaultOpen)
  return (
    <div>
      <button type="button" onClick={() => setOpen(!open)} className="flex min-h-8 items-center gap-1 text-xs text-muted-foreground hover:text-foreground">
        <ChevronRight className={cn('size-3.5 transition-transform', open && 'rotate-90')} />
        {label}
      </button>
      {open && <div className="mt-1">{children}</div>}
    </div>
  )
}

export function TellList({ report }: { report: TellReport }) {
  const hits = [...report.hits].sort((a, b) => b.weight - a.weight || a.start - b.start)
  if (!hits.length) return <div className="text-xs text-muted-foreground">Nothing flagged.</div>
  return (
    <ul className="space-y-1.5">
      {hits.map((h, i) => (
        <li key={i} className={cn('rounded-md border px-2.5 py-1.5 text-xs', h.weight >= STRONG_WEIGHT ? 'border-destructive/30 bg-destructive/5' : 'bg-muted/30')}>
          <div className="flex flex-wrap items-baseline gap-x-2">
            <span className="font-medium text-foreground">{h.label}</span>
            <span className="text-muted-foreground">“{h.match}”</span>
            <span className="ml-auto text-[11px] text-muted-foreground">{h.weight >= STRONG_WEIGHT ? 'strong' : 'weak'}</span>
          </div>
          <div className="mt-0.5 text-muted-foreground">{h.fix}</div>
        </li>
      ))}
    </ul>
  )
}

export function DiffView({ a, b }: { a: string; b: string }) {
  const parts = useMemo(() => wordDiff(a, b), [a, b])
  return (
    <div className="text-[13px] whitespace-pre-wrap break-words text-foreground/85">
      {parts.map((p, i) =>
        p.type === 'same' ? (
          <span key={i}>{p.text}</span>
        ) : p.type === 'del' ? (
          <del key={i} className="rounded-sm bg-destructive/15 text-destructive/90 decoration-destructive/60">
            {p.text}
          </del>
        ) : (
          <ins key={i} className="rounded-sm bg-success/15 text-success no-underline">
            {p.text}
          </ins>
        ),
      )}
    </div>
  )
}

type View = 'edited' | 'original' | 'diff'

/**
 * How the user reviews any draft: the current (edited) text with tells marked, a score, the flagged
 * phrases with fixes, and, when the editor pass ran, a toggle to the original / a diff plus the
 * editor's reasons.
 */
export function WritingReview({
  current,
  original,
  changes,
  rejected,
  actions,
  className,
}: {
  current: string
  original?: string | null | undefined
  changes?: EditorChange[] | null | undefined
  rejected?: string | null | undefined
  /** Extra buttons shown next to the view toggle (e.g. "Use original"). Receives the view. */
  actions?: (view: View) => ReactNode
  className?: string
}) {
  const hasOriginal = !!original && original !== current
  const [view, setView] = useState<View>('edited')
  const [marks, setMarks] = useState(true)
  const now = useTellReport(current)
  const before = useTellReport(hasOriginal ? original : null)
  const shown = view === 'original' && hasOriginal ? before : now
  const text = view === 'original' && hasOriginal ? original! : current
  return (
    <div className={cn('space-y-2', className)}>
      <div className="flex flex-wrap items-center gap-1.5">
        {hasOriginal && (
          <Segmented<View>
            value={view}
            onChange={setView}
            options={[
              { value: 'edited', label: 'Edited' },
              { value: 'original', label: 'Original' },
              { value: 'diff', label: 'Changes' },
            ]}
          />
        )}
        <TellScore report={view === 'original' ? before : now} was={view === 'original' ? null : before} />
        {view !== 'diff' && (
          <button
            type="button"
            onClick={() => setMarks(!marks)}
            className={cn('inline-flex size-7 items-center justify-center rounded-md text-muted-foreground hover:bg-accent', marks && 'text-foreground')}
            aria-label={marks ? 'Hide highlights' : 'Highlight tells'}
            title={marks ? 'Hide highlights' : 'Highlight tells'}
          >
            <Highlighter className="size-3.5" />
          </button>
        )}
        {actions?.(view)}
      </div>
      {view === 'diff' && hasOriginal ? <DiffView a={original!} b={current} /> : <HighlightedText text={text} hits={marks ? shown?.hits : null} />}
      <div className="space-y-0.5">
        {shown && shown.hits.length > 0 && (
          <Disclosure label={`${shown.hits.length} flagged phrase${shown.hits.length === 1 ? '' : 's'}${view === 'original' ? ' in the original' : ''}`}>
            <TellList report={shown} />
          </Disclosure>
        )}
        {(changes?.length || rejected) && (
          <Disclosure label={rejected ? 'Editor pass: kept the original' : `Editor pass: ${changes!.length} change${changes!.length === 1 ? '' : 's'}`}>
            {rejected && <div className="mb-1 text-xs text-muted-foreground">{rejected}</div>}
            <ul className="space-y-1.5">
              {(changes ?? []).map((c, i) => (
                <li key={i} className="rounded-md bg-muted/30 px-2.5 py-1.5 text-xs">
                  <div className="text-foreground">{c.what}</div>
                  <div className="text-muted-foreground">{c.why}</div>
                </li>
              ))}
            </ul>
          </Disclosure>
        )}
      </div>
    </div>
  )
}
