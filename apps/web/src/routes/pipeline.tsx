import { useQueryClient, useSuspenseQuery } from '@tanstack/react-query'
import { createFileRoute, Link, useNavigate } from '@tanstack/react-router'
import { ArrowDown, ArrowUp, ArrowUpDown, ClipboardCheck, ListRestart, Plus } from 'lucide-react'
import { useState } from 'react'
import { z } from 'zod'
import { Empty, PageHeader } from '~/components/app/bits'
import { AppRow } from '~/components/app/cards'
import { Segmented } from '~/components/app/segmented'
import { Button } from '~/components/ui/button'
import { Checkbox } from '~/components/ui/checkbox'
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '~/components/ui/dialog'
import { Input } from '~/components/ui/input'
import { Label } from '~/components/ui/label'
import { createApplicationFn, qo, rpc } from '~/lib/api'
import { STAGE_META, STAGES, type Stage } from '@sidedoor/shared/format'
import { useAction } from '~/lib/use-action'
import { cn } from '~/lib/utils'

/** What an empty column means, so it reads as a state rather than a gap. */
const EMPTY_COLUMN: Partial<Record<string, string>> = {
  interested: 'Roles you go after land here.',
  review: 'No packages waiting for you.',
  approved: 'Nothing approved and unsent.',
  applied: 'Nothing sent yet.',
  screening: 'No recruiter screens yet.',
  interviewing: 'No interviews yet.',
  offer: 'No offers yet.',
}

export const Route = createFileRoute('/pipeline')({
  validateSearch: z.object({ stage: z.string().optional().catch(undefined), closed: z.boolean().optional().catch(undefined) }),
  loader: ({ context }) => context.queryClient.ensureQueryData(qo.applications()),
  component: Pipeline,
})

const working = (a: { prep: { running: boolean } | null }) => (a.prep ? (a.prep.running ? 2 : 1) : 0)

type OpenApp = Awaited<ReturnType<typeof rpc.applications>>['open'][number]

/**
 * A column's order. The ones you (or your AI) ranked come first, in your order. The rest follow:
 * what your AI is working on (running, then waiting), then high priority, then best odds, then best fit.
 */
const columnOrder = (a: OpenApp, b: OpenApp) =>
  (a.rank ?? Infinity) - (b.rank ?? Infinity) ||
  working(b) - working(a) ||
  (a.priority === 'high' ? -1 : 0) - (b.priority === 'high' ? -1 : 0) ||
  (b.shot ?? -1) - (a.shot ?? -1) ||
  (b.fitScore ?? 0) - (a.fitScore ?? 0)

/** The card's place among the ranked ones in its column (1 = first), for the "#n" on it. */
const withPlaces = (items: OpenApp[]) => items.map((a, i) => ({ ...a, rank: a.rank != null ? i + 1 : null }))

const BOARD: Stage[] = ['interested', 'review', 'approved', 'applied', 'screening', 'interviewing', 'offer']

function Pipeline() {
  const { data } = useSuspenseQuery(qo.applications())
  const search = Route.useSearch()
  const navigate = useNavigate({ from: '/pipeline' })
  const [adding, setAdding] = useState(false)
  const [reordering, setReordering] = useState(false)
  const [drag, setDrag] = useState<{ id: string; stage: string; over: string | null } | null>(null)
  const qc = useQueryClient()
  const byStage = (s: Stage) => withPlaces(data.open.filter((a) => a.stage === s).sort(columnOrder))

  /** Save a column's new order: the whole column becomes ranked, in this order. Shown at once, saved behind. */
  const saveOrder = (ids: string[]) => {
    qc.setQueryData(qo.applications().queryKey, (d) => (d ? { ...d, open: d.open.map((a) => (ids.includes(a.id) ? { ...a, rank: ids.indexOf(a.id) + 1 } : a)) } : d))
    void rpc.rankApplications({ ids }).catch(() => void qc.invalidateQueries({ queryKey: qo.applications().queryKey }))
  }
  const move = (s: Stage, id: string, to: number) => {
    const ids = byStage(s).map((a) => a.id).filter((x) => x !== id)
    ids.splice(Math.max(0, Math.min(to, ids.length)), 0, id)
    saveOrder(ids)
  }
  const clearOrder = (s: Stage) => {
    const ids = byStage(s).filter((a) => a.rank != null).map((a) => a.id)
    qc.setQueryData(qo.applications().queryKey, (d) => (d ? { ...d, open: d.open.map((a) => (ids.includes(a.id) ? { ...a, rank: null } : a)) } : d))
    void rpc.unrankApplications({ ids }).catch(() => void qc.invalidateQueries({ queryKey: qo.applications().queryKey }))
  }

  /** A card in a column: drag it to reorder (desktop), or use the arrows in reorder mode. */
  const card = (s: Stage, a: OpenApp, i: number, n: number) => (
    <div
      key={a.id}
      draggable
      onDragStart={(e) => {
        e.dataTransfer.effectAllowed = 'move'
        e.dataTransfer.setData('text/plain', a.id)
        setDrag({ id: a.id, stage: s, over: null })
      }}
      onDragEnd={() => setDrag(null)}
      onDragOver={(e) => {
        if (!drag || drag.stage !== s) return
        e.preventDefault()
        if (drag.over !== a.id) setDrag({ ...drag, over: a.id })
      }}
      onDrop={(e) => {
        e.preventDefault()
        if (!drag || drag.stage !== s || drag.id === a.id) return setDrag(null)
        // Dropped on a card: take its place (cards below it move down).
        const ids = byStage(s).map((x) => x.id)
        const target = ids.filter((x) => x !== drag.id).indexOf(a.id)
        move(s, drag.id, ids.indexOf(drag.id) < ids.indexOf(a.id) ? target + 1 : target)
        setDrag(null)
      }}
      className={cn('flex items-stretch gap-1', drag?.id === a.id && 'opacity-40', drag && drag.over === a.id && drag.id !== a.id && 'rounded-xl ring-2 ring-primary/50')}
    >
      <div className="min-w-0 flex-1">
        <AppRow a={a} showStage={false} showListing />
      </div>
      {reordering && (
        <div className="flex shrink-0 flex-col justify-center gap-1">
          <Button variant="ghost" size="icon" className="size-7" disabled={i === 0} aria-label="Move up" onClick={() => move(s, a.id, i - 1)}>
            <ArrowUp />
          </Button>
          <Button variant="ghost" size="icon" className="size-7" disabled={i === n - 1} aria-label="Move down" onClick={() => move(s, a.id, i + 1)}>
            <ArrowDown />
          </Button>
        </div>
      )}
    </div>
  )
  const mobileStage = (search.stage as Stage | undefined) ?? BOARD.find((s) => byStage(s).length > 0 && ['review', 'approved', 'applied'].includes(s)) ?? 'review'

  return (
    <div>
      <PageHeader
        title="Pipeline"
        subtitle={data.open.length ? `${data.open.length} open application${data.open.length === 1 ? '' : 's'}, from interested to offer.` : 'Jobs you go after show up here, from interested to offer.'}
        actions={
          <>
            <Button asChild variant="secondary" size="sm">
              <Link to="/review">
                <ClipboardCheck /> Review queue
              </Link>
            </Button>
            <Button variant={reordering ? 'default' : 'outline'} size="sm" onClick={() => setReordering((r) => !r)}>
              <ArrowUpDown /> {reordering ? 'Done' : 'Reorder'}
            </Button>
            <Button variant="outline" size="sm" onClick={() => void navigate({ search: (s) => ({ ...s, closed: !s.closed }) })}>
              {search.closed ? 'Hide closed' : 'Show closed'}
            </Button>
            <Button size="sm" onClick={() => setAdding(true)}>
              <Plus /> Add
            </Button>
          </>
        }
      />

      {/* Mobile: one stage at a time */}
      <div className="md:hidden">
        <div className="-mx-4 mb-3 overflow-x-auto px-4 scrollbar-none">
          <Segmented
            value={mobileStage}
            options={BOARD.map((s) => ({ value: s, label: `${STAGE_META[s].short} ${byStage(s).length || ''}`.trim() }))}
            onChange={(v) => void navigate({ search: (s) => ({ ...s, stage: v }), replace: true })}
          />
        </div>
        <div className="space-y-2">
          {byStage(mobileStage).map((a, i, all) => card(mobileStage, a, i, all.length))}
          {byStage(mobileStage).length === 0 && <Empty>{EMPTY_COLUMN[mobileStage] ?? 'Nothing here.'}</Empty>}
        </div>
      </div>

      {/* Desktop: board */}
      <div className="-mx-8 hidden overflow-x-auto px-8 pb-4 md:block">
        <div className="flex gap-3">
          {BOARD.map((s) => {
            const items = byStage(s)
            return (
              <div key={s} className="min-w-64 flex-1 basis-0">
                <div className="mb-2 flex items-center gap-2 px-1">
                  <span className={cn('rounded-full px-2 py-0.5 text-[11px] font-medium', STAGE_META[s].tone)}>{STAGE_META[s].label}</span>
                  <span className="text-xs text-muted-foreground">{items.length}</span>
                  {items.some((a) => a.rank != null) && (
                    <Button variant="ghost" size="icon" className="ml-auto size-6 text-muted-foreground" title="Clear your order for this column" aria-label="Clear order" onClick={() => clearOrder(s)}>
                      <ListRestart className="size-3.5" />
                    </Button>
                  )}
                </div>
                <div className="max-h-[calc(100dvh-220px)] space-y-2 overflow-y-auto pr-1">
                  {items.map((a, i) => card(s, a, i, items.length))}
                  {items.length === 0 && <div className="rounded-xl border border-dashed p-4 text-center text-xs text-muted-foreground">{EMPTY_COLUMN[s] ?? 'Nothing here.'}</div>}
                </div>
              </div>
            )
          })}
        </div>
      </div>

      {search.closed && (
        <div className="mt-8 space-y-2">
          <h2 className="px-1 text-sm font-semibold">Closed</h2>
          {data.closed.map((a) => (
            <AppRow key={a.id} a={a} />
          ))}
        </div>
      )}
      <AddApplication open={adding} onOpenChange={setAdding} />
    </div>
  )
}

function AddApplication({ open, onOpenChange }: { open: boolean; onOpenChange: (o: boolean) => void }) {
  const navigate = useNavigate()
  const [companyName, setCompany] = useState('')
  const [role, setRole] = useState('')
  const [jobUrl, setUrl] = useState('')
  const [research, setResearch] = useState(true)
  const [prep, setPrep] = useState(false)
  const create = useAction((d: { companyName: string; role: string; jobUrl?: string; research: boolean; prep: boolean; source: string }) => createApplicationFn({ data: d }), { success: 'Added' })
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Add an application</DialogTitle>
        </DialogHeader>
        <div className="space-y-3">
          <div className="space-y-1.5">
            <Label>Company</Label>
            <Input value={companyName} onChange={(e) => setCompany(e.target.value)} placeholder="Ramp" />
          </div>
          <div className="space-y-1.5">
            <Label>Role</Label>
            <Input value={role} onChange={(e) => setRole(e.target.value)} placeholder="Engineering Manager, Payments" />
          </div>
          <div className="space-y-1.5">
            <Label>Job URL (optional)</Label>
            <Input value={jobUrl} onChange={(e) => setUrl(e.target.value)} placeholder="https://…" />
          </div>
          <label className="flex items-center gap-2 text-sm">
            <Checkbox checked={research} onCheckedChange={(v) => setResearch(v === true)} /> Research the company and find people to contact
          </label>
          <label className="flex items-center gap-2 text-sm">
            <Checkbox checked={prep} onCheckedChange={(v) => setPrep(v === true)} /> Prepare a tailored resume + application package
          </label>
        </div>
        <DialogFooter>
          <Button
            disabled={!companyName || !role || create.pending}
            onClick={async () => {
              const r = await create.run({ companyName, role, research, prep, source: 'manual', ...(jobUrl ? { jobUrl } : {}) })
              if (r) {
                onOpenChange(false)
                void navigate({ to: '/applications/$id', params: { id: r.id } })
              }
            }}
          >
            Add
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
