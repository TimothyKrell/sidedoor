import { useQuery } from '@tanstack/react-query'
import { createFileRoute, Link, useNavigate } from '@tanstack/react-router'
import { Loader2, Search } from 'lucide-react'
import { useEffect, useState } from 'react'
import { z } from 'zod'
import { Empty, PageHeader } from '~/components/app/bits'
import { PostingCard } from '~/components/app/cards'
import { Segmented } from '~/components/app/segmented'
import { Input } from '~/components/ui/input'
import { qo } from '~/lib/api'

const Search_ = z.object({
  window: z.enum(['6h', '24h', '72h', '7d', '30d', 'all']).optional().catch(undefined),
  decision: z.enum(['triaged', 'queue', 'maybe', 'skip', 'all']).optional().catch(undefined),
  status: z.enum(['new', 'starred', 'dismissed', 'tracked', 'all']).optional().catch(undefined),
  q: z.string().optional().catch(undefined),
  minFit: z.number().optional().catch(undefined),
})

const withDefaults = (s: z.infer<typeof Search_>) => ({ ...s, window: s.window ?? '7d', decision: s.decision ?? 'triaged', status: s.status ?? 'new' }) as const

export const Route = createFileRoute('/jobs/')({
  validateSearch: Search_,
  loaderDeps: ({ search }) => withDefaults(search),
  loader: ({ context, deps }) => context.queryClient.ensureQueryData(qo.postings(deps)),
  component: Jobs,
})

const WINDOWS = [
  { value: '6h', label: '6h' },
  { value: '24h', label: '24h' },
  { value: '72h', label: '3d' },
  { value: '7d', label: '7d' },
  { value: '30d', label: '30d' },
  { value: 'all', label: 'All' },
] as const
const DECISIONS = [
  { value: 'triaged', label: 'Worth a look' },
  { value: 'queue', label: 'Strong fit' },
  { value: 'maybe', label: 'Maybe' },
  { value: 'skip', label: 'Skipped' },
] as const
const STATUSES = [
  { value: 'new', label: 'Inbox' },
  { value: 'starred', label: 'Starred' },
  { value: 'tracked', label: 'Tracking' },
  { value: 'dismissed', label: 'Dismissed' },
  { value: 'all', label: 'All' },
] as const

function Jobs() {
  const raw = Route.useSearch()
  const search = withDefaults(raw)
  const navigate = useNavigate({ from: '/jobs/' })
  const { data, isFetching } = useQuery(qo.postings(search))
  const { data: today } = useQuery(qo.today())
  const setup = today?.setup
  const [q, setQ] = useState(raw.q ?? '')
  useEffect(() => {
    const t = setTimeout(() => {
      if ((raw.q ?? '') !== q) void navigate({ search: (s) => ({ ...s, q: q || undefined }), replace: true })
    }, 300)
    return () => clearTimeout(t)
  }, [q, raw.q, navigate])
  const set = (patch: Partial<z.infer<typeof Search_>>) => navigate({ search: (s) => ({ ...s, ...patch }), replace: true })

  return (
    <div>
      <PageHeader title="Jobs" subtitle="New postings from your sources, newest first, scored against what you want." />
      <div className="sticky top-[53px] z-20 -mx-4 mb-4 space-y-2 border-b bg-background/90 px-4 py-2.5 backdrop-blur md:static md:mx-0 md:border-0 md:bg-transparent md:p-0 md:backdrop-blur-none">
        <div className="relative">
          <Search className="absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Filter by company, title, location…" className="pl-9" />
          {isFetching && <Loader2 className="absolute top-1/2 right-3 size-4 -translate-y-1/2 animate-spin text-muted-foreground" />}
        </div>
        <div className="flex gap-2 overflow-x-auto scrollbar-none">
          <Segmented value={search.status} options={STATUSES} onChange={(v) => void set({ status: v })} />
          <Segmented value={search.window} options={WINDOWS} onChange={(v) => void set({ window: v })} />
          <Segmented value={search.decision === 'all' ? 'triaged' : search.decision} options={DECISIONS} onChange={(v) => void set({ decision: v })} />
        </div>
      </div>
      {data && data.length > 0 ? (
        <div className="grid grid-cols-1 gap-2 lg:grid-cols-2">
          {data.map((p) => (
            <PostingCard key={p.id} p={p} />
          ))}
        </div>
      ) : (
        <Empty>
          {setup && setup.sources === 0 ? (
            <>
              You aren’t watching any job sources yet.{' '}
              <Link to="/sources" className="font-medium text-foreground underline-offset-2 hover:underline">
                Add sources
              </Link>
            </>
          ) : setup && setup.postings === 0 ? (
            `The scout is reading your ${setup.sources} source${setup.sources === 1 ? '' : 's'} for the first time. Postings show up here in a minute or two.`
          ) : setup && setup.triaged === 0 && search.decision !== 'all' ? (
            'Postings are in, but your AI hasn’t scored any yet. Scored ones show up here.'
          ) : (
            'No postings match. Try a longer time range, like 30d.'
          )}
        </Empty>
      )}
      {data && data.length >= 150 && <p className="mt-4 text-center text-xs text-muted-foreground">Showing the newest 150. Narrow the filters to see more.</p>}
    </div>
  )
}
