import { type ReactNode, useState } from 'react'
import { createPortal } from 'react-dom'
import { cn } from '~/lib/utils'

/** Hover or focus a mark for its numbers. Every value here is also on the page or in a table. */
export function Hover({ tip, className, style, children, focusable }: { tip: ReactNode; className?: string; style?: React.CSSProperties; children?: ReactNode; focusable?: boolean }) {
  const [at, setAt] = useState<{ x: number; y: number } | null>(null)
  return (
    <div
      className={className}
      style={style}
      {...(focusable ? { tabIndex: 0 } : {})}
      onPointerMove={(e) => setAt({ x: e.clientX, y: e.clientY })}
      onPointerLeave={() => setAt(null)}
      onFocus={(e) => {
        const r = e.currentTarget.getBoundingClientRect()
        setAt({ x: r.left + r.width / 2, y: r.top })
      }}
      onBlur={() => setAt(null)}
    >
      {children}
      {at &&
        createPortal(
          <div
            className="pointer-events-none fixed z-50 max-w-60 -translate-x-1/2 -translate-y-full rounded-lg border bg-popover px-2.5 py-1.5 text-xs text-popover-foreground shadow-md"
            style={{ left: Math.min(Math.max(at.x, 124), window.innerWidth - 124), top: at.y - 10 }}
          >
            {tip}
          </div>,
          document.body,
        )}
    </div>
  )
}

export function Legend({ items }: { items: Array<{ label: string; color: string; n?: number }> }) {
  return (
    <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
      {items.map((i) => (
        <span key={i.label} className="flex items-center gap-1.5">
          <span className="size-2.5 rounded-[3px]" style={{ background: i.color }} />
          {i.label}
          {i.n !== undefined && <span className="font-medium text-foreground tabular-nums">{i.n}</span>}
        </span>
      ))}
    </div>
  )
}

/** Two counts on one axis: the first grows up from the line, the second down, at the same scale. */
export function MirrorBars({ rows, up, down }: { rows: Array<{ key: string; label: string; up: number; down: number }>; up: { label: string; color: string }; down: { label: string; color: string } }) {
  const maxUp = Math.max(1, ...rows.map((r) => r.up))
  const maxDown = Math.max(...rows.map((r) => r.down), 0)
  const scale = maxUp + maxDown
  const base = (maxUp / scale) * 100
  const every = Math.ceil(rows.length / 8)
  return (
    <div className="flex gap-2">
      <div className="relative h-56 w-5 shrink-0 text-right text-[11px] text-muted-foreground tabular-nums">
        <span className="absolute top-0 right-0">{maxUp}</span>
        <span className="absolute right-0 -translate-y-1/2" style={{ top: `${base}%` }}>0</span>
        {maxDown > 0 && <span className="absolute right-0 bottom-0">{maxDown}</span>}
      </div>
      <div className="min-w-0 flex-1">
        <div className="relative flex h-56">
          <div className="absolute inset-x-0 border-t" style={{ top: `${base}%` }} />
          {rows.map((r) => (
            <Hover
              key={r.key}
              className="group relative min-w-0 flex-1 rounded-sm hover:bg-muted/60"
              tip={
                <>
                  <div className="mb-0.5 text-muted-foreground">{r.label}</div>
                  <div><b className="tabular-nums">{r.up}</b> {up.label.toLowerCase()}</div>
                  <div><b className="tabular-nums">{r.down}</b> {down.label.toLowerCase()}</div>
                </>
              }
            >
              {r.up > 0 && <div className="absolute left-1/2 w-[70%] max-w-6 min-w-0.5 -translate-x-1/2 rounded-t" style={{ background: up.color, bottom: `calc(${100 - base}% + 1px)`, height: `max(3px, calc(${(r.up / scale) * 100}% - 1px))` }} />}
              {r.down > 0 && <div className="absolute left-1/2 w-[70%] max-w-6 min-w-0.5 -translate-x-1/2 rounded-b" style={{ background: down.color, top: `calc(${base}% + 1px)`, height: `max(3px, calc(${(r.down / scale) * 100}% - 1px))` }} />}
            </Hover>
          ))}
        </div>
        <div className="mt-1.5 flex text-[11px] text-muted-foreground">
          {rows.map((r, i) => (
            <div key={r.key} className="relative h-4 min-w-0 flex-1">
              {i % every === 0 && <span className="absolute left-1/2 -translate-x-1/2 whitespace-nowrap">{r.label}</span>}
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}

/** Upright bars with one color, for an ordered axis (days, score bands). */
export function Columns({ rows, color = 'var(--viz-waiting)', height = 'h-32', labelAll, noun }: { rows: Array<{ key: string; label: string; n: number }>; color?: string; height?: string; labelAll?: boolean; noun: string }) {
  const max = Math.max(1, ...rows.map((r) => r.n))
  const peak = rows.reduce((best, r) => (r.n > (best?.n ?? 0) ? r : best), rows[0])
  const every = labelAll ? 1 : Math.ceil(rows.length / 6)
  return (
    <div>
      <div className={cn('relative flex items-end border-b', height)}>
        {rows.map((r) => (
          <Hover key={r.key} className="relative flex h-full min-w-0 flex-1 items-end justify-center rounded-sm hover:bg-muted/60" tip={<><b className="tabular-nums">{r.n.toLocaleString()}</b> {noun} <span className="text-muted-foreground">· {r.label}</span></>}>
            {r === peak && r.n > 0 && <span className="absolute left-1/2 -translate-x-1/2 text-[11px] font-medium tabular-nums" style={{ bottom: `calc(${(r.n / max) * 86}% + 2px)` }}>{r.n.toLocaleString()}</span>}
            {r.n > 0 && <div className="w-[70%] max-w-6 min-w-0.5 rounded-t" style={{ background: color, height: `max(3px, ${(r.n / max) * 86}%)` }} />}
          </Hover>
        ))}
      </div>
      <div className="mt-1.5 flex text-[11px] text-muted-foreground">
        {rows.map((r, i) => (
          <div key={r.key} className="relative h-4 min-w-0 flex-1">
            {i % every === 0 && <span className="absolute left-1/2 -translate-x-1/2 whitespace-nowrap">{r.label}</span>}
          </div>
        ))}
      </div>
    </div>
  )
}

/** A ranked list with a bar under each row's label and the value at the end. */
export function RowBars({ rows, color = 'var(--viz-waiting)', format = (n) => n.toLocaleString() }: { rows: Array<{ label: string; n: number; color?: string; note?: string }>; color?: string; format?: (n: number) => string }) {
  const max = Math.max(1, ...rows.map((r) => r.n))
  return (
    <div className="space-y-2.5">
      {rows.map((r) => (
        <div key={r.label}>
          <div className="mb-1 flex items-baseline justify-between gap-3 text-sm">
            <span className="min-w-0 truncate">{r.label}</span>
            <span className="shrink-0 tabular-nums">
              <span className="font-medium">{format(r.n)}</span>
              {r.note && <span className="ml-1.5 text-xs text-muted-foreground">{r.note}</span>}
            </span>
          </div>
          <div className="h-1.5 rounded-full bg-muted">
            <div className="h-full rounded-full" style={{ width: `max(4px, ${(r.n / max) * 100}%)`, background: r.color ?? color }} />
          </div>
        </div>
      ))}
    </div>
  )
}

/** One bar split into parts of a whole, with a 2px gap between them. */
export function SplitBar({ parts, className }: { parts: Array<{ label: string; n: number; color: string }>; className?: string }) {
  const shown = parts.filter((p) => p.n > 0)
  const total = shown.reduce((s, p) => s + p.n, 0)
  return (
    <div className={cn('flex h-3 gap-0.5', className)}>
      {shown.map((p) => (
        <Hover key={p.label} className="h-full min-w-1 first:rounded-l last:rounded-r hover:opacity-80" style={{ flexGrow: p.n, flexBasis: 0, background: p.color }} tip={<><b className="tabular-nums">{p.n}</b> {p.label.toLowerCase()} <span className="text-muted-foreground">· {Math.round((p.n / total) * 100)}%</span></>} />
      ))}
    </div>
  )
}

/** A year-view grid: a column per week, Monday on top, darker for more. */
export function CalendarGrid({ days, weeks = 18, today }: { days: Array<{ date: string; submitted: number; rejected: number }>; weeks?: number; today: Date }) {
  const byDate = new Map(days.map((d) => [d.date, d]))
  const max = Math.max(1, ...days.map((d) => d.submitted))
  const key = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
  const monday = new Date(today.getFullYear(), today.getMonth(), today.getDate() - ((today.getDay() + 6) % 7) - (weeks - 1) * 7)
  const cols = Array.from({ length: weeks }, (_, w) => Array.from({ length: 7 }, (_, i) => new Date(monday.getFullYear(), monday.getMonth(), monday.getDate() + w * 7 + i)))
  const label = (d: Date) => d.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' })
  return (
    <div>
      <div className="flex gap-1">
        {cols.map((col) => (
          <div key={key(col[0]!)} className="flex min-w-0 flex-1 flex-col gap-1">
            <div className="h-4 text-[11px] whitespace-nowrap text-muted-foreground">{col[0]!.getDate() <= 7 ? col[0]!.toLocaleDateString(undefined, { month: 'short' }) : ''}</div>
            {col.map((d) => {
              const v = byDate.get(key(d))
              const n = v?.submitted ?? 0
              if (d > today) return <div key={key(d)} className="aspect-square max-h-5" />
              return (
                <Hover
                  key={key(d)}
                  className="aspect-square max-h-5 rounded-[3px] bg-muted hover:outline-2 hover:outline-foreground/40"
                  {...(n ? { style: { background: `color-mix(in oklch, var(--viz-waiting) ${35 + (n / max) * 65}%, var(--muted))` } } : {})}
                  tip={
                    <>
                      <div className="text-muted-foreground">{label(d)}</div>
                      <div><b className="tabular-nums">{n}</b> submitted{v?.rejected ? <>, <b className="tabular-nums">{v.rejected}</b> rejected</> : null}</div>
                    </>
                  }
                />
              )
            })}
          </div>
        ))}
      </div>
    </div>
  )
}
