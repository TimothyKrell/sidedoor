import { Check, MessageSquarePlus, RotateCcw, Undo2, X } from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'
import { DiffView } from '~/components/app/writing'
import { Button } from '~/components/ui/button'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '~/components/ui/select'
import { Switch } from '~/components/ui/switch'
import { Textarea } from '~/components/ui/textarea'
import type { LineChange as Change } from '@sidedoor/shared/resume'
import { STRONG_WEIGHT, type TellHit, type TellReport } from '@sidedoor/shared/tells'
import { cn } from '~/lib/utils'

export type Spot = { target: string | null; quote?: string; noteId?: string } | null

// ---------------------------------------------------------------- your AI's changes

const KIND = { changed: 'Edited', added: 'Added', removed: 'Removed' } as const

export function ChangesPanel({ changes, onKeep, onUndo, onSpot, onFocus }: {
  changes: Change[]
  onKeep: (ids: string[]) => void
  onUndo: (ids: string[]) => void
  onSpot: (id: string | null) => void
  onFocus: (id: string) => void
}) {
  if (!changes.length)
    return (
      <div className="px-6 py-10 text-center text-sm leading-relaxed text-muted-foreground">
        Nothing to review.
        <br />
        When your AI edits this resume, each change shows up here for you to keep, tweak or undo.
      </div>
    )
  const ids = changes.map((c) => c.id)
  return (
    <div className="space-y-2.5 p-3">
      <div className="flex items-center gap-2 px-1">
        <span className="text-xs text-muted-foreground">Click a change to jump to it. Edit the line in the resume to tweak it, then keep it.</span>
      </div>
      <div className="flex gap-2 px-1">
        <Button size="sm" onClick={() => onKeep(ids)}>
          <Check /> Keep all
        </Button>
        <Button size="sm" variant="outline" onClick={() => onUndo(ids)}>
          <Undo2 /> Undo all
        </Button>
      </div>
      {changes.map((c) => (
        <div
          key={c.id}
          className="cursor-pointer rounded-lg border border-info/30 bg-card p-3 transition-colors hover:border-info/70"
          onMouseEnter={() => onSpot(c.kind === 'removed' ? null : c.id)}
          onMouseLeave={() => onSpot(null)}
          onClick={() => c.kind !== 'removed' && onFocus(c.id)}
        >
          <div className="mb-1.5 text-[11px] font-medium tracking-wide text-info uppercase">{KIND[c.kind]}</div>
          {c.kind === 'changed' ? (
            <DiffView a={c.before} b={c.after} />
          ) : c.kind === 'added' ? (
            <div className="text-[13px] text-success">{c.after}</div>
          ) : (
            <div className="text-[13px] text-destructive/90 line-through decoration-destructive/60">{c.before}</div>
          )}
          <div className="mt-2.5 flex gap-2" onClick={(e) => e.stopPropagation()}>
            <Button size="sm" className="h-7" onClick={() => onKeep([c.id])}>
              <Check /> Keep
            </Button>
            <Button size="sm" variant="ghost" className="h-7" onClick={() => onUndo([c.id])}>
              <Undo2 /> Undo
            </Button>
          </div>
        </div>
      ))}
    </div>
  )
}

export function TellsPanel({ report, showWeak, setShowWeak, focused, onPick }: {
  report: TellReport | null
  showWeak: boolean
  setShowWeak: (v: boolean) => void
  focused: TellHit | null
  onPick: (h: TellHit) => void
}) {
  if (!report) return <div className="p-6 text-center text-sm text-muted-foreground">Loading the rules…</div>
  const hits = report.hits.filter((h) => showWeak || h.weight >= STRONG_WEIGHT).sort((a, b) => a.start - b.start)
  const weak = report.hits.length - hits.length
  return (
    <div className="space-y-2 p-3">
      <div className="px-1 text-xs text-muted-foreground">
        Score <b className="text-foreground">{+report.score.toFixed(2)}</b> · <b className="text-foreground">{report.hits.length}</b> hits · <b className="text-foreground">{report.per100}</b> per 100 words ({report.words} words)
      </div>
      <label className="flex items-center gap-2 px-1 text-xs text-muted-foreground" title="Weak tells (weight under 1), like lists of three, only matter in clusters">
        <Switch checked={showWeak} onCheckedChange={setShowWeak} /> Show weak{weak ? ` (${weak} hidden)` : ''}
      </label>
      {hits.length ? (
        hits.map((h, i) => (
          <button
            key={`${h.start}-${h.id}-${i}`}
            type="button"
            onClick={() => onPick(h)}
            className={cn(
              'block w-full rounded-md border border-l-[3px] bg-card px-2.5 py-1.5 text-left text-xs hover:border-primary',
              h.weight >= STRONG_WEIGHT ? 'border-l-destructive' : 'border-l-info',
              focused === h && 'border-primary',
            )}
          >
            <div className="flex justify-between gap-2 font-medium">
              <span className={h.weight >= STRONG_WEIGHT ? 'text-destructive' : 'text-info'}>{h.label}</span>
              <span className="text-muted-foreground">{h.weight}</span>
            </div>
            <div className="truncate text-muted-foreground">{h.match}</div>
            {focused === h && <div className="mt-1 text-foreground/85">{h.fix}</div>}
          </button>
        ))
      ) : (
        <div className="py-6 text-center text-sm text-muted-foreground">No tells found.</div>
      )}
    </div>
  )
}
