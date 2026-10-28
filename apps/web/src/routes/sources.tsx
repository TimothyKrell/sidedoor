import { useSuspenseQuery } from '@tanstack/react-query'
import { createFileRoute } from '@tanstack/react-router'
import { Flame, Pause, Play, Plus, Search } from 'lucide-react'
import { useMemo, useState } from 'react'
import { z } from 'zod'
import { PageHeader, TimeAgo } from '~/components/app/bits'
import { Segmented } from '~/components/app/segmented'
import { Button } from '~/components/ui/button'
import { Checkbox } from '~/components/ui/checkbox'
import { Input } from '~/components/ui/input'
import { addSourceFn, qo, updateSourceFn } from '~/lib/api'
import { useAction } from '~/lib/use-action'
import { cn } from '~/lib/utils'

const VIEWS = ['active', 'candidate', 'paused', 'rejected'] as const

export const Route = createFileRoute('/sources')({
  validateSearch: z.object({ view: z.enum(VIEWS).optional().catch(undefined), q: z.string().optional().catch(undefined) }),
  loader: ({ context }) => context.queryClient.ensureQueryData(qo.sources()),
  component: Sources,
})

function Sources() {
  const { data } = useSuspenseQuery(qo.sources())
  const search = Route.useSearch()
  const navigate = Route.useNavigate()
  const view = search.view ?? 'active'
  const q = search.q ?? ''
  const setView = (v: (typeof VIEWS)[number]) => void navigate({ search: (s) => ({ ...s, view: v }), replace: true })
  const setQ = (v: string) => void navigate({ search: (s) => ({ ...s, q: v || undefined }), replace: true })
  const [url, setUrl] = useState('')
  const [company, setCompany] = useState('')
  const [hot, setHot] = useState(false)
  const add = useAction((v: { url: string; companyName?: string; hot?: boolean }) => addSourceFn({ data: v }), { success: (r) => `Added “${r.board}”. Checking it now.` })
  const update = useAction((v: { id: string; status?: 'active' | 'paused' | 'candidate' | 'rejected'; tier?: 'hot' | 'normal' }) => updateSourceFn({ data: v }))
  const rows = useMemo(() => data.filter((s) => s.status === view && (!q || `${s.name} ${s.board} ${s.kind}`.toLowerCase().includes(q.toLowerCase()))), [data, view, q])
  const counts = (s: string) => data.filter((x) => x.status === s).length
  return (
    <div className="space-y-5">
      <PageHeader title="Job sources" subtitle="Job boards and company career pages the scout watches. Priority ones are checked every few minutes, the rest every 15." />
      <div className="space-y-2 rounded-xl border bg-card p-3.5">
        <div className="text-sm font-medium">Watch a company or feed</div>
        <div className="flex flex-col gap-2 sm:flex-row">
          <Input value={url} onChange={(e) => setUrl(e.target.value)} placeholder="A company careers page, job board link or RSS feed" className="flex-1" />
          <Input value={company} onChange={(e) => setCompany(e.target.value)} placeholder="Company (optional)" className="sm:w-48" />
          <label className="flex items-center gap-2 text-sm whitespace-nowrap">
            <Checkbox checked={hot} onCheckedChange={(v) => setHot(v === true)} /> Priority
          </label>
          <Button disabled={!url || add.pending} onClick={async () => { const r = await add.run({ url, ...(company ? { companyName: company } : {}), hot }); if (r) { setUrl(''); setCompany('') } }}>
            <Plus /> Add
          </Button>
        </div>
        <p className="text-xs text-muted-foreground">Greenhouse, Lever, Ashby, Workable and SmartRecruiters are detected from any job URL. A bare token like “ramp” is probed across all of them.</p>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <Segmented
          value={view}
          onChange={setView}
          options={[
            { value: 'active', label: `Active ${counts('active')}` },
            { value: 'candidate', label: `Candidates ${counts('candidate')}` },
            { value: 'paused', label: `Paused ${counts('paused')}` },
            { value: 'rejected', label: `Rejected ${counts('rejected')}` },
          ]}
        />
        <div className="relative ml-auto w-full sm:w-64">
          <Search className="absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Filter" className="h-8 pl-9" />
        </div>
      </div>
      <div className="divide-y rounded-xl border bg-card">
        {rows.map((s) => (
          <div key={s.id} className="flex items-center gap-3 px-3.5 py-2.5 text-sm">
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-1.5 truncate font-medium">
                {s.tier === 'hot' && <Flame className="size-3.5 text-hot" />}
                {s.name}
                <span className="font-normal text-muted-foreground">
                  · {s.kind}:{s.board.length > 40 ? `${s.board.slice(0, 40)}…` : s.board}
                </span>
              </div>
              <div className={cn('truncate text-xs text-muted-foreground', s.lastError && 'text-destructive')}>
                {s.lastError ? `Error: ${s.lastError}` : s.lastCheckedAt ? <>{s.lastJobCount ?? 0} open · {s.openMatches} matches · checked <TimeAgo iso={s.lastCheckedAt} /></> : s.why ?? 'Not checked yet'}
              </div>
            </div>
            <Button size="icon" variant="ghost" className={cn('size-8', s.tier === 'hot' && 'text-hot')} onClick={() => void update.run({ id: s.id, tier: s.tier === 'hot' ? 'normal' : 'hot' })} aria-label="Toggle priority" title="Priority: checked every few minutes">
              <Flame />
            </Button>
            {s.status === 'active' ? (
              <Button size="icon" variant="ghost" className="size-8" onClick={() => void update.run({ id: s.id, status: 'paused' })} aria-label="Pause">
                <Pause />
              </Button>
            ) : (
              <Button size="icon" variant="ghost" className="size-8" onClick={() => void update.run({ id: s.id, status: 'active' })} aria-label="Activate">
                <Play />
              </Button>
            )}
          </div>
        ))}
        {rows.length === 0 && <div className="p-4 text-sm text-muted-foreground">None.</div>}
      </div>
    </div>
  )
}
