import { cn } from '~/lib/utils'

export function Segmented<T extends string>({ value, options, onChange, className }: { value: T; options: ReadonlyArray<{ value: T; label: string }>; onChange: (v: T) => void; className?: string }) {
  return (
    <div className={cn('inline-flex shrink-0 rounded-lg border bg-card p-0.5', className)}>
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          onClick={() => onChange(o.value)}
          className={cn('rounded-md px-2.5 py-1 text-xs whitespace-nowrap text-muted-foreground transition-colors', value === o.value && 'bg-secondary font-medium text-foreground')}
        >
          {o.label}
        </button>
      ))}
    </div>
  )
}
