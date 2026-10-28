import { useSuspenseQuery } from '@tanstack/react-query'
import { createFileRoute, useNavigate } from '@tanstack/react-router'
import { Plus } from 'lucide-react'
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
import { createApplicationFn, qo } from '~/lib/api'
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

const BOARD: Stage[] = ['interested', 'review', 'approved', 'applied', 'screening', 'interviewing', 'offer']

function Pipeline() {
  const { data } = useSuspenseQuery(qo.applications())
  const search = Route.useSearch()
  const navigate = useNavigate({ from: '/pipeline' })
  const [adding, setAdding] = useState(false)
  const byStage = (s: Stage) =>
    data.open
      .filter((a) => a.stage === s)
      // What your AI is working on first (running, then waiting), then high priority, then best fit.
      .sort((a, b) => working(b) - working(a) || (a.priority === 'high' ? -1 : 0) - (b.priority === 'high' ? -1 : 0) || (b.fitScore ?? 0) - (a.fitScore ?? 0))
  const mobileStage = (search.stage as Stage | undefined) ?? BOARD.find((s) => byStage(s).length > 0 && ['review', 'approved', 'applied'].includes(s)) ?? 'review'

  return (
    <div>
      <PageHeader
        title="Pipeline"
        subtitle={data.open.length ? `${data.open.length} open application${data.open.length === 1 ? '' : 's'}, from interested to offer.` : 'Jobs you go after show up here, from interested to offer.'}
        actions={
          <>
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
          {byStage(mobileStage).map((a) => (
            <AppRow key={a.id} a={a} showStage={false} showListing />
          ))}
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
                </div>
                <div className="max-h-[calc(100dvh-220px)] space-y-2 overflow-y-auto pr-1">
                  {items.map((a) => (
                    <AppRow key={a.id} a={a} showStage={false} showListing />
                  ))}
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
