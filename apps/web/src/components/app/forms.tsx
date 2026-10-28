import { CalendarClock } from 'lucide-react'
import { useEffect, useState } from 'react'
import { Button } from '~/components/ui/button'
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '~/components/ui/dialog'
import { Input } from '~/components/ui/input'
import { Label } from '~/components/ui/label'
import { Popover, PopoverContent, PopoverTrigger } from '~/components/ui/popover'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '~/components/ui/select'
import { Textarea } from '~/components/ui/textarea'
import { logInteractionFn, savePersonFn, scheduleFollowupFn } from '~/lib/api'
import { dueLabel, PERSON_KIND_LABEL, plusDays } from '@sidedoor/shared/format'
import { useAction } from '~/lib/use-action'
import { cn } from '~/lib/utils'

type Kind = 'recruiter' | 'hiring-manager' | 'founder' | 'referral' | 'network' | 'interviewer' | 'other'

export interface PersonDraft {
  id?: string
  name: string
  companyName: string
  title: string
  kind: Kind
  email: string
  linkedin: string
  x: string
  nextContactAt: string
  nextAction: string
  whyMd: string
}

const blank: PersonDraft = { name: '', companyName: '', title: '', kind: 'recruiter', email: '', linkedin: '', x: '', nextContactAt: '', nextAction: '', whyMd: '' }

export function PersonDialog({ open, onOpenChange, initial, applicationId, onSaved }: { open: boolean; onOpenChange: (o: boolean) => void; initial?: Partial<PersonDraft>; applicationId?: string; onSaved?: (id: string) => void }) {
  const [v, setV] = useState<PersonDraft>({ ...blank, ...initial })
  useEffect(() => {
    if (open) setV({ ...blank, ...initial })
  }, [open, initial])
  const save = useAction((d: Parameters<typeof savePersonFn>[0]['data']) => savePersonFn({ data: d }), { success: 'Saved' })
  const f = (k: keyof PersonDraft) => ({ value: v[k] ?? '', onChange: (e: { target: { value: string } }) => setV({ ...v, [k]: e.target.value }) })
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90dvh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{v.id ? 'Edit contact' : 'Add a contact'}</DialogTitle>
        </DialogHeader>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <div className="space-y-1.5 sm:col-span-2">
            <Label>Name</Label>
            <Input {...f('name')} placeholder="Jane Doe" autoFocus />
          </div>
          <div className="space-y-1.5">
            <Label>Company</Label>
            <Input {...f('companyName')} />
          </div>
          <div className="space-y-1.5">
            <Label>Title</Label>
            <Input {...f('title')} />
          </div>
          <div className="space-y-1.5">
            <Label>Type</Label>
            <Select value={v.kind} onValueChange={(k) => setV({ ...v, kind: k as Kind })}>
              <SelectTrigger className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {Object.entries(PERSON_KIND_LABEL).map(([k, l]) => (
                  <SelectItem key={k} value={k}>
                    {l}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1.5">
            <Label>Email</Label>
            <Input {...f('email')} type="email" />
          </div>
          <div className="space-y-1.5">
            <Label>LinkedIn</Label>
            <Input {...f('linkedin')} placeholder="https://www.linkedin.com/in/…" />
          </div>
          <div className="space-y-1.5">
            <Label>X</Label>
            <Input {...f('x')} placeholder="@handle or x.com/…" />
          </div>
          <div className="space-y-1.5">
            <Label>Next follow-up</Label>
            <Input {...f('nextContactAt')} type="date" />
          </div>
          <div className="space-y-1.5">
            <Label>Next action</Label>
            <Input {...f('nextAction')} />
          </div>
          <div className="space-y-1.5 sm:col-span-2">
            <Label>Why they matter / notes</Label>
            <Textarea {...f('whyMd')} rows={3} />
          </div>
        </div>
        <DialogFooter>
          <Button
            disabled={!v.name || save.pending}
            onClick={async () => {
              const r = await save.run({
                ...(v.id ? { id: v.id } : {}),
                name: v.name,
                companyName: v.companyName || null,
                title: v.title || null,
                kind: v.kind,
                email: v.email || null,
                ...(v.email ? { emailConfidence: 'published' } : {}),
                linkedin: v.linkedin || null,
                x: v.x || null,
                nextContactAt: v.nextContactAt || null,
                nextAction: v.nextAction || null,
                whyMd: v.whyMd || null,
                ...(applicationId ? { applicationId } : {}),
              })
              if (r) {
                onOpenChange(false)
                onSaved?.(r.id)
              }
            }}
          >
            Save
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

const QUICK = [
  { label: 'I emailed', channel: 'email', direction: 'out' as const },
  { label: 'LinkedIn msg', channel: 'linkedin', direction: 'out' as const },
  { label: 'X DM', channel: 'x', direction: 'out' as const },
  { label: 'They replied', channel: 'email', direction: 'in' as const },
  { label: 'Call / meeting', channel: 'call', direction: 'in' as const },
  { label: 'Note', channel: 'other', direction: 'note' as const },
]

/** One-tap touchpoint logging. Outbound contact schedules the next follow-up automatically. */
export function InteractionForm({ personId, applicationId, defaultCadence = 7 }: { personId?: string; applicationId?: string; defaultCadence?: number }) {
  const [mode, setMode] = useState<(typeof QUICK)[number] | null>(null)
  const [summary, setSummary] = useState('')
  const [days, setDays] = useState(String(defaultCadence))
  const log = useAction((d: Parameters<typeof logInteractionFn>[0]['data']) => logInteractionFn({ data: d }), { success: 'Logged' })
  return (
    <div className="space-y-2">
      <div className="flex flex-wrap gap-1.5">
        {QUICK.map((q) => (
          <Button key={q.label} size="sm" variant={mode?.label === q.label ? 'default' : 'outline'} className="h-7 text-xs" onClick={() => setMode(mode?.label === q.label ? null : q)}>
            {q.label}
          </Button>
        ))}
      </div>
      {mode && (
        <div className="space-y-2 rounded-xl border bg-card p-3">
          <Textarea autoFocus value={summary} onChange={(e) => setSummary(e.target.value)} rows={2} placeholder={mode.direction === 'in' ? 'What did they say?' : mode.direction === 'note' ? 'Note…' : 'What did you send?'} />
          <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
            {mode.direction === 'out' && personId && (
              <>
                Follow up in
                <Input value={days} onChange={(e) => setDays(e.target.value)} className="h-7 w-14 text-xs" inputMode="numeric" />
                days
              </>
            )}
            <Button
              size="sm"
              className="ml-auto h-7"
              disabled={!summary.trim() || log.pending}
              onClick={async () => {
                await log.run({
                  ...(personId ? { personId } : {}),
                  ...(applicationId ? { applicationId } : {}),
                  channel: mode.channel,
                  direction: mode.direction,
                  summary,
                  ...(mode.direction === 'out' && personId ? { nextContactInDays: Number(days) || null } : {}),
                })
                setSummary('')
                setMode(null)
              }}
            >
              Log it
            </Button>
          </div>
        </div>
      )}
    </div>
  )
}

/** Small "follow up: in 3d" control with quick presets. */
export function FollowupPicker({ date, personId, applicationId, action }: { date: string | null; personId?: string; applicationId?: string; action?: string | null }) {
  const [open, setOpen] = useState(false)
  const [custom, setCustom] = useState(date ?? '')
  const set = useAction((d: { date: string | null }) => scheduleFollowupFn({ data: { ...(personId ? { personId } : {}), ...(applicationId ? { applicationId } : {}), date: d.date, ...(action !== undefined && action !== null ? { action } : {}) } }), { success: 'Follow-up updated' })
  const label = dueLabel(date)
  const pick = async (d: string | null) => {
    await set.run({ date: d })
    setOpen(false)
  }
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button variant="outline" size="sm" className={cn('h-8', label?.overdue && 'border-destructive/50 text-destructive')}>
          <CalendarClock /> {label ? `Follow up ${label.overdue ? `· ${label.text}` : label.text.replace(/^Due /, '')}` : 'Set follow-up'}
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-64 space-y-2" align="start">
        <div className="grid grid-cols-3 gap-1.5">
          {[
            ['Today', 0],
            ['Tomorrow', 1],
            ['3 days', 3],
            ['1 week', 7],
            ['2 weeks', 14],
            ['1 month', 30],
          ].map(([l, n]) => (
            <Button key={l} size="sm" variant="secondary" className="h-7 text-xs" onClick={() => void pick(plusDays(Number(n)))}>
              {l}
            </Button>
          ))}
        </div>
        <div className="flex gap-1.5">
          <Input type="date" value={custom} onChange={(e) => setCustom(e.target.value)} className="h-8 text-xs" />
          <Button size="sm" className="h-8" onClick={() => void pick(custom || null)}>
            Set
          </Button>
        </div>
        {date && (
          <Button size="sm" variant="ghost" className="h-7 w-full text-xs" onClick={() => void pick(null)}>
            Clear (done for now)
          </Button>
        )}
      </PopoverContent>
    </Popover>
  )
}
