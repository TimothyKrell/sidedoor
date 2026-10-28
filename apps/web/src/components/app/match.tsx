import { ArrowRight, ChevronDown, Lightbulb, Loader2, MessageSquarePlus, Quote, RefreshCw, TriangleAlert } from 'lucide-react'
import { type ReactNode, useState } from 'react'
import { TimeAgo } from '~/components/app/bits'
import { Segmented } from '~/components/app/segmented'
import { Button } from '~/components/ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '~/components/ui/tooltip'
import { LEVEL_META, levelCounts, MATCH_LEVELS, type MatchLevel, type MatchRequirement, type ResumeMatch, scoreTone } from '@sidedoor/shared/match'
import { cn } from '~/lib/utils'

// How well a resume answers a posting: a score ring and level bar to take in at a glance, then one
// row per requirement with the resume line that answers it. Used on the application page and in
// the resume editor's Match tab.

export function MatchRing({ score, size = 64, className }: { score: number; size?: number; className?: string }) {
  const r = 15.5
  const c = 2 * Math.PI * r
  return (
    <div className={cn('relative shrink-0', scoreTone(score), className)} style={{ width: size, height: size }}>
      <svg viewBox="0 0 36 36" className="size-full -rotate-90">
        <circle cx="18" cy="18" r={r} fill="none" stroke="currentColor" strokeOpacity={0.15} strokeWidth={3.5} />
        <circle cx="18" cy="18" r={r} fill="none" stroke="currentColor" strokeWidth={3.5} strokeLinecap="round" strokeDasharray={`${(c * score) / 100} ${c}`} />
      </svg>
      <div className="absolute inset-0 flex flex-col items-center justify-center leading-none">
        <span className="font-semibold tabular-nums text-foreground" style={{ fontSize: size * 0.3 }}>
          {score}
        </span>
        {size >= 56 && <span className="mt-0.5 text-[11px] tracking-wide text-muted-foreground uppercase">match</span>}
      </div>
    </div>
  )
}

/** One segment per requirement, grouped by level: the shape of the match in one line. */
export function LevelBar({ reqs, className }: { reqs: Pick<MatchRequirement, 'level'>[]; className?: string }) {
  const counts = levelCounts(reqs)
  return (
    <div className={cn('flex h-2.5 w-full gap-0.5 overflow-hidden rounded-full', className)}>
      {MATCH_LEVELS.filter((l) => counts[l]).map((l) => (
        <div key={l} className={cn('h-full first:rounded-l-full last:rounded-r-full', LEVEL_META[l].bg)} style={{ flexGrow: counts[l] }} title={`${counts[l]} ${LEVEL_META[l].label.toLowerCase()}`} />
      ))}
    </div>
  )
}

export function LevelLegend({ reqs, className }: { reqs: Pick<MatchRequirement, 'level'>[]; className?: string }) {
  const counts = levelCounts(reqs)
  return (
    <div className={cn('flex flex-wrap gap-x-3 gap-y-1 text-xs', className)}>
      {MATCH_LEVELS.map((l) => (
        <span key={l} className={cn('inline-flex items-center gap-1.5', !counts[l] && 'opacity-40')}>
          <span className={cn('size-2 rounded-full', LEVEL_META[l].bg)} />
          <span className="font-medium tabular-nums">{counts[l]}</span>
          <span className="text-muted-foreground">{LEVEL_META[l].label.toLowerCase()}</span>
        </span>
      ))}
    </div>
  )
}

/** Three pips: how strongly the resume answers one requirement. */
export function LevelPips({ level, className }: { level: MatchLevel; className?: string }) {
  const m = LEVEL_META[level]
  return (
    <span className={cn('inline-flex items-center gap-0.5', className)} title={m.label}>
      {[1, 2, 3].map((i) => (
        <span key={i} className={cn('h-2.5 w-1.5 rounded-[2px]', i <= m.dots ? m.bg : level === 'missing' ? 'bg-destructive/25' : 'bg-muted-foreground/20')} />
      ))}
    </span>
  )
}

const mustCovered = (reqs: MatchRequirement[]) => {
  const must = reqs.filter((r) => r.kind === 'must')
  return { covered: must.filter((r) => r.level === 'strong' || r.level === 'partial').length, total: must.length }
}

export function MatchSummary({ match, stale, running, onRecheck, actions, className }: {
  match: ResumeMatch
  stale: boolean
  running: boolean
  onRecheck: () => void
  actions?: ReactNode
  className?: string
}) {
  const must = mustCovered(match.requirements)
  return (
    <div className={cn('rounded-xl border bg-card p-4', className)}>
      <div className="flex items-center gap-4">
        <MatchRing score={match.score} size={68} />
        <div className="min-w-0 flex-1 space-y-2">
          <div className="flex flex-wrap items-baseline gap-x-3 gap-y-0.5">
            <span className="text-sm font-semibold">Resume match</span>
            {must.total > 0 && (
              <span className="text-xs text-muted-foreground">
                <span className={cn('font-medium tabular-nums', must.covered === must.total ? 'text-success' : 'text-foreground')}>
                  {must.covered}/{must.total}
                </span>{' '}
                must-haves covered
              </span>
            )}
          </div>
          <LevelBar reqs={match.requirements} />
          <LevelLegend reqs={match.requirements} />
        </div>
      </div>
      <p className="mt-3 text-sm text-muted-foreground">{match.summary}</p>
      <div className="mt-3 flex flex-wrap items-center gap-2">
        <RecheckButton stale={stale} running={running} onRecheck={onRecheck} />
        {actions}
        <span className="ml-auto text-[11px] text-muted-foreground">
          checked <TimeAgo iso={match.at} />
        </span>
      </div>
    </div>
  )
}

export function RecheckButton({ stale, running, onRecheck, className }: { stale: boolean; running: boolean; onRecheck: () => void; className?: string }) {
  if (running)
    return (
      <span className={cn('inline-flex items-center gap-1.5 text-xs text-muted-foreground', className)}>
        <Loader2 className="size-3.5 animate-spin text-primary" /> Checking against the resume…
      </span>
    )
  return (
    <Button size="sm" variant={stale ? 'secondary' : 'ghost'} className={cn('h-7 text-xs', stale && 'text-hot', className)} onClick={onRecheck} title="Re-judge each requirement against the resume as it reads now">
      {stale ? <TriangleAlert /> : <RefreshCw />} {stale ? 'Resume changed: re-check' : 'Re-check'}
    </Button>
  )
}

type Filter = 'all' | 'gaps'

/**
 * Requirements and the resume lines that answer them. `liveText` (the editor's current lines)
 * flags evidence edited since the check; the spot/focus callbacks tie rows to resume lines.
 */
export function MatchList({ match, compact = false, liveText, onSpot, onFocus, onStrengthen }: {
  match: ResumeMatch
  compact?: boolean
  liveText?: Map<string, string>
  onSpot?: (lineId: string | null) => void
  onFocus?: (lineId: string) => void
  onStrengthen?: (r: MatchRequirement) => void
}) {
  const [filter, setFilter] = useState<Filter>('all')
  const [open, setOpen] = useState<string | null>(null)
  const gaps = match.requirements.filter((r) => r.level === 'weak' || r.level === 'missing').length
  const groups = (['must', 'nice'] as const)
    .map((k) => ({ kind: k, reqs: match.requirements.filter((r) => r.kind === k && (filter === 'all' || r.level === 'weak' || r.level === 'missing')) }))
    .filter((g) => g.reqs.length)
  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2">
        <Segmented
          value={filter}
          onChange={setFilter}
          options={[
            { value: 'all', label: `All ${match.requirements.length}` },
            { value: 'gaps', label: `Gaps ${gaps}` },
          ]}
        />
        {!compact && <span className="hidden text-xs text-muted-foreground sm:inline">Hover for the full text. Click a row for details.</span>}
      </div>
      {!compact && (
        <div className="hidden grid-cols-[5.5rem_minmax(0,1fr)_1rem_minmax(0,1fr)] gap-3 px-3 text-[11px] font-medium tracking-wide text-muted-foreground uppercase md:grid">
          <span>Match</span>
          <span>They want</span>
          <span />
          <span>Your resume</span>
        </div>
      )}
      {groups.map((g) => (
        <div key={g.kind} className="space-y-1.5">
          <div className="px-1 text-xs font-semibold text-muted-foreground">{g.kind === 'must' ? 'Must-haves' : 'Nice-to-haves'}</div>
          {g.reqs.map((r) => (
            <RequirementRow
              key={r.id}
              r={r}
              compact={compact}
              open={open === r.id}
              onToggle={() => setOpen(open === r.id ? null : r.id)}
              liveText={liveText}
              onSpot={onSpot}
              onFocus={onFocus}
              onStrengthen={onStrengthen}
            />
          ))}
        </div>
      ))}
      {!groups.length && <div className="px-1 py-6 text-center text-sm text-muted-foreground">No gaps. Every requirement has at least partial evidence.</div>}
    </div>
  )
}

const norm = (s: string) => s.replace(/\s+/g, ' ').trim()

function Hover({ text, children, className }: { text: string; children: ReactNode; className?: string }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span className={className}>{children}</span>
      </TooltipTrigger>
      <TooltipContent side="top" className="max-w-sm text-left text-pretty">
        {text}
      </TooltipContent>
    </Tooltip>
  )
}

function RequirementRow({ r, compact, open, onToggle, liveText, onSpot, onFocus, onStrengthen }: {
  r: MatchRequirement
  compact: boolean
  open: boolean
  onToggle: () => void
  liveText?: Map<string, string>
  onSpot?: (lineId: string | null) => void
  onFocus?: (lineId: string) => void
  onStrengthen?: (r: MatchRequirement) => void
}) {
  const m = LEVEL_META[r.level]
  const first = r.evidence[0]
  const state = (lineId: string, was: string) => {
    if (!liveText) return null
    const now = liveText.get(lineId)
    return now === undefined ? 'removed' : norm(now) !== norm(was) ? 'edited' : null
  }
  const changed = r.evidence.some((e) => state(e.lineId, e.text))
  const evidence = first ? (
    <span className="flex min-w-0 items-center gap-1.5">
      <Hover text={liveText?.get(first.lineId) ?? first.text} className="truncate">
        {first.short}
      </Hover>
      {r.evidence.length > 1 && <span className="shrink-0 text-[11px] text-muted-foreground">+{r.evidence.length - 1}</span>}
      {changed && <span className="shrink-0 rounded bg-hot/15 px-1 text-[11px] text-hot">edited</span>}
    </span>
  ) : (
    <span className="text-muted-foreground italic">Nothing on the resume</span>
  )

  return (
    <div
      className={cn('rounded-lg border border-l-[3px] bg-card transition-colors hover:bg-accent/40', m.border, open && 'bg-accent/30')}
      onMouseEnter={() => first && onSpot?.(first.lineId)}
      onMouseLeave={() => onSpot?.(null)}
    >
      <button type="button" onClick={onToggle} className="w-full px-3 py-2.5 text-left text-sm">
        {compact ? (
          <div className="space-y-1">
            <div className="flex items-center gap-2">
              <LevelPips level={r.level} />
              <Hover text={r.quote} className="min-w-0 flex-1 truncate font-medium">
                {r.short}
              </Hover>
              <ChevronDown className={cn('size-3.5 shrink-0 text-muted-foreground transition-transform', open && 'rotate-180')} />
            </div>
            <div className="flex items-center gap-1.5 pl-6 text-xs">
              <ArrowRight className={cn('size-3 shrink-0', m.text)} />
              {evidence}
            </div>
          </div>
        ) : (
          <div className="grid grid-cols-[auto_minmax(0,1fr)] items-center gap-x-3 gap-y-1 md:grid-cols-[5.5rem_minmax(0,1fr)_1rem_minmax(0,1fr)]">
            <span className="flex items-center gap-2">
              <LevelPips level={r.level} />
              <span className={cn('text-xs font-medium', m.text)}>{m.label}</span>
            </span>
            <Hover text={r.quote} className="truncate font-medium">
              {r.short}
            </Hover>
            <ArrowRight className={cn('hidden size-3.5 md:block', m.text)} />
            <span className="col-start-2 flex min-w-0 items-center gap-1.5 text-muted-foreground md:col-start-auto md:text-foreground">
              <ArrowRight className={cn('size-3 shrink-0 md:hidden', m.text)} />
              {evidence}
            </span>
          </div>
        )}
      </button>
      {open && (
        <div className="space-y-3 border-t px-3 py-3 text-sm">
          <div className={cn('grid gap-3', !compact && 'md:grid-cols-2')}>
            <div className="space-y-1">
              <div className="text-[11px] font-medium tracking-wide text-muted-foreground uppercase">The posting says</div>
              <blockquote className="flex gap-2 rounded-md bg-muted/50 p-2.5 text-[13px] leading-relaxed">
                <Quote className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" />
                <span>{r.quote}</span>
              </blockquote>
            </div>
            <div className="space-y-1">
              <div className="text-[11px] font-medium tracking-wide text-muted-foreground uppercase">Your resume</div>
              {r.evidence.length ? (
                r.evidence.map((e) => {
                  const s = state(e.lineId, e.text)
                  return (
                    <button
                      key={e.lineId}
                      type="button"
                      disabled={!onFocus || s === 'removed'}
                      onClick={() => onFocus?.(e.lineId)}
                      onMouseEnter={() => onSpot?.(e.lineId)}
                      className={cn('block w-full rounded-md p-2.5 text-left text-[13px] leading-relaxed', m.soft, onFocus && 'hover:ring-1 hover:ring-current/30')}
                    >
                      {liveText?.get(e.lineId) ?? e.text}
                      {s && <span className="ml-1.5 rounded bg-hot/15 px-1 text-[11px] text-hot">{s === 'removed' ? 'line removed since check' : 'edited since check'}</span>}
                    </button>
                  )
                })
              ) : (
                <div className="rounded-md border border-dashed p-2.5 text-[13px] text-muted-foreground">No line on the resume answers this.</div>
              )}
            </div>
          </div>
          <p className="text-[13px] text-muted-foreground">
            <span className={cn('font-medium', m.text)}>{m.label}.</span> {r.note}
          </p>
          {r.fix && (
            <div className="flex gap-2 rounded-md border border-primary/30 bg-primary/5 p-2.5 text-[13px]">
              <Lightbulb className="mt-0.5 size-3.5 shrink-0 text-primary" />
              <span>{r.fix}</span>
            </div>
          )}
          {onStrengthen && r.level !== 'strong' && (
            <Button size="sm" variant="outline" className="h-7 text-xs" onClick={() => onStrengthen(r)}>
              <MessageSquarePlus /> Note for your AI: strengthen this
            </Button>
          )}
        </div>
      )}
    </div>
  )
}

/** One-line match status for the top of the application page. */
export function MatchStrip({ match, stale, onOpen }: { match: ResumeMatch; stale: boolean; onOpen: () => void }) {
  const must = mustCovered(match.requirements)
  const gaps = match.requirements.filter((r) => r.kind === 'must' && (r.level === 'weak' || r.level === 'missing'))
  return (
    <button type="button" onClick={onOpen} className="flex w-full items-center gap-3 rounded-xl border bg-card px-3 py-2.5 text-left transition-colors hover:bg-accent/40">
      <MatchRing score={match.score} size={40} />
      <div className="min-w-0 flex-1 space-y-1.5">
        <div className="flex flex-wrap items-baseline gap-x-2 text-sm">
          <span className="font-medium">Resume match</span>
          {must.total > 0 && (
            <span className="text-xs text-muted-foreground">
              {must.covered}/{must.total} must-haves
            </span>
          )}
          {gaps.length > 0 && <span className="truncate text-xs text-destructive">Gap: {gaps.map((g) => g.short).join(', ')}</span>}
          {stale && <span className="text-xs text-hot">· resume changed since check</span>}
        </div>
        <LevelBar reqs={match.requirements} className="h-1.5" />
      </div>
      <ArrowRight className="size-4 shrink-0 text-muted-foreground" />
    </button>
  )
}
