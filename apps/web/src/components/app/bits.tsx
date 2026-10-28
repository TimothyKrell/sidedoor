import { Link, useRouter } from '@tanstack/react-router'
import { Check, Copy, Flame } from 'lucide-react'
import { renderMarkdown } from '~/lib/markdown'
import { type CSSProperties, type ReactNode, useEffect, useMemo, useState } from 'react'
import { toast } from 'sonner'
import { Badge } from '~/components/ui/badge'
import { Button } from '~/components/ui/button'
import { ageHours, dueLabel, fitTone, fmtDate, salaryRange, STAGE_META, type Stage, timeAgo } from '@sidedoor/shared/format'
import { cn } from '~/lib/utils'

export function FitBadge({ fit, className }: { fit: number | null | undefined; className?: string }) {
  if (fit == null) return null
  return <span className={cn('inline-flex h-6 min-w-8 items-center justify-center rounded-md px-1.5 font-mono text-xs font-semibold tabular-nums', fitTone(fit), className)}>{fit}</span>
}

/** Shown only when triage doubts the user can take the job from where they are. The note says why. */
export function LocationFlag({ fit, note }: { fit: string | null | undefined; note: string | null | undefined }) {
  if (fit !== 'no' && fit !== 'unclear') return null
  return (
    <span
      title={note ?? undefined}
      // A label, not a button: no outline, so it never reads as clickable next to the card's actions.
      className={cn('inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-medium whitespace-nowrap', fit === 'no' ? 'bg-destructive/15 text-destructive' : 'bg-primary/10 text-primary')}
    >
      {fit === 'no' ? 'Not where you can work' : 'Location unclear'}
    </span>
  )
}

export function LocationNote({ fit, note }: { fit: string | null | undefined; note: string | null | undefined }) {
  if (fit !== 'no' && fit !== 'unclear') return null
  return (
    <div className="mt-2 flex flex-wrap items-center gap-2 text-xs">
      <LocationFlag fit={fit} note={note} />
      {note && <span className="text-muted-foreground">{note}</span>}
    </div>
  )
}

export function StageBadge({ stage }: { stage: string }) {
  const m = STAGE_META[stage as Stage] ?? STAGE_META.interested
  return <span className={cn('inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-medium whitespace-nowrap', m.tone)}>{m.label}</span>
}

/** Re-renders every 30s so "12m ago" stays honest. */
export function useNow(ms = 30_000) {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), ms)
    return () => clearInterval(t)
  }, [ms])
  return now
}

export function TimeAgo({ iso, className }: { iso: string | null | undefined; className?: string }) {
  const now = useNow()
  return (
    <time className={className} dateTime={iso ?? undefined} title={iso ? new Date(iso).toLocaleString() : undefined} suppressHydrationWarning>
      {timeAgo(iso, now)}
    </time>
  )
}

/** How old a posting is: "posted" when the board gave a date, "seen" when we only know when the scout found it. Hot when new. */
export function Freshness({ postedAt, firstSeenAt }: { postedAt: string | null; firstSeenAt: string }) {
  useNow()
  const h = ageHours(postedAt, firstSeenAt)
  const hot = h !== null && h < 24
  const title = postedAt ? `Posted ${fmtDate(postedAt)} · first seen ${fmtDate(firstSeenAt)}` : `The board gives no posted date. First seen ${fmtDate(firstSeenAt)}.`
  return (
    <span title={title} className={cn('inline-flex items-center gap-1 text-xs whitespace-nowrap', hot ? 'font-medium text-hot' : 'text-muted-foreground')} suppressHydrationWarning>
      {hot && <Flame className="size-3" />}
      {postedAt ? 'posted' : 'seen'} {timeAgo(postedAt ?? firstSeenAt)}
    </span>
  )
}

/** The salary range, short; hover for the board's full compensation text. Nothing when there's no figure. */
export function Salary({ text, min, max, className }: { text: string | null | undefined; min?: number | null; max?: number | null; className?: string }) {
  const range = salaryRange(text, min, max)
  if (!range) return null
  return (
    <span title={text ?? undefined} className={cn('text-xs font-medium whitespace-nowrap tabular-nums', className)}>
      {range}
    </span>
  )
}

export function Due({ date, className }: { date: string | null | undefined; className?: string }) {
  const d = dueLabel(date)
  if (!d) return null
  return <span className={cn('text-xs whitespace-nowrap', d.overdue ? 'font-medium text-destructive' : d.soon ? 'text-primary' : 'text-muted-foreground', className)}>{d.text}</span>
}

export function Section({ title, count, action, children, className }: { title: ReactNode; count?: number; action?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <section className={cn('space-y-2.5', className)}>
      <div className="flex items-center gap-2 px-1">
        <h2 className="text-sm font-semibold tracking-tight">{title}</h2>
        {count !== undefined && count > 0 && <Badge variant="secondary" className="h-5 rounded-full px-1.5 text-[11px]">{count}</Badge>}
        <div className="ml-auto">{action}</div>
      </div>
      {children}
    </section>
  )
}

export function Empty({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={cn('rounded-xl border border-dashed px-4 py-6 text-center text-sm text-muted-foreground', className)}>{children}</div>
}

export function PageHeader({ title, subtitle, actions }: { title: ReactNode; subtitle?: ReactNode; actions?: ReactNode }) {
  return (
    <div className="mb-5 flex flex-wrap items-end gap-3">
      <div className="min-w-0 flex-1">
        <h1 className="truncate text-xl font-semibold tracking-tight md:text-2xl">{title}</h1>
        {subtitle && <div className="mt-0.5 text-sm text-muted-foreground">{subtitle}</div>}
      </div>
      {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
    </div>
  )
}

export function CopyButton({ text, label = 'Copy', className, size = 'sm' }: { text: string; label?: string; className?: string; size?: 'sm' | 'icon' | 'default' }) {
  const [done, setDone] = useState(false)
  return (
    <Button
      variant="outline"
      size={size}
      className={className}
      onClick={async () => {
        await navigator.clipboard.writeText(text)
        setDone(true)
        toast.success('Copied')
        setTimeout(() => setDone(false), 1500)
      }}
    >
      {done ? <Check /> : <Copy />}
      {size !== 'icon' && label}
    </Button>
  )
}

/** Renders agent/package markdown. Internal links (/applications/…) navigate in-app. */
export function Markdown({ children, className }: { children: string | null | undefined; className?: string }) {
  const router = useRouter()
  const html = useMemo(() => renderMarkdown(children), [children])
  return (
    <div
      className={cn('prose-sd break-words', className)}
      onClick={(e) => {
        const a = (e.target as HTMLElement).closest('a')
        const href = a?.getAttribute('href')
        if (href?.startsWith('/') && !href.startsWith('/editor')) {
          e.preventDefault()
          void router.navigate({ to: href })
        }
      }}
      // Sanitized by renderMarkdown (DOMPurify).
      dangerouslySetInnerHTML={{ __html: html }}
    />
  )
}

export function ExternalLink({ href, children, className }: { href: string | null | undefined; children: ReactNode; className?: string }) {
  if (!href) return null
  return (
    <a href={href} target="_blank" rel="noreferrer" className={cn('text-primary underline-offset-2 hover:underline', className)}>
      {children}
    </a>
  )
}

export function CompanyAvatar({ name, className }: { name: string | null | undefined; className?: string }) {
  const n = (name ?? '?').trim()
  let h = 0
  for (const c of n) h = (h * 31 + c.charCodeAt(0)) % 360
  return (
    // A soft tint per company in light mode, a deep one in dark, so rows of companies don't blur together.
    <span
      className={cn('inline-flex size-9 shrink-0 items-center justify-center rounded-lg text-sm font-semibold', 'bg-[oklch(0.94_0.045_var(--h))] text-[oklch(0.42_0.11_var(--h))] dark:bg-[oklch(0.32_0.06_var(--h))] dark:text-[oklch(0.9_0.08_var(--h))]', className)}
      style={{ '--h': h } as CSSProperties}
    >
      {n.slice(0, 1).toUpperCase()}
    </span>
  )
}

export { Link }
