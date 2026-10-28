import { useQuery } from '@tanstack/react-query'
import { createFileRoute, useNavigate } from '@tanstack/react-router'
import { Plus, Search } from 'lucide-react'
import { useEffect, useState } from 'react'
import { z } from 'zod'
import { Empty, PageHeader } from '~/components/app/bits'
import { DraftCard, PersonRow } from '~/components/app/cards'
import { PersonDialog } from '~/components/app/forms'
import { Segmented } from '~/components/app/segmented'
import { Button } from '~/components/ui/button'
import { Input } from '~/components/ui/input'
import { qo } from '~/lib/api'

const S = z.object({
  view: z.enum(['drafts', 'due', 'all', 'recruiters', 'engaged', 'not-contacted']).optional().catch(undefined),
  q: z.string().optional().catch(undefined),
})

export const Route = createFileRoute('/people/')({
  validateSearch: S,
  loaderDeps: ({ search }) => ({ ...search, view: search.view ?? 'all' }),
  loader: ({ context, deps }) => (deps.view === 'drafts' ? context.queryClient.ensureQueryData(qo.today()) : context.queryClient.ensureQueryData(qo.people({ ...deps, view: deps.view as PeopleView }))),
  component: People,
})

type PeopleView = Exclude<z.infer<typeof S>['view'], 'drafts' | undefined>

const VIEWS = [
  { value: 'drafts', label: 'Drafts to send' },
  { value: 'due', label: 'Follow up' },
  { value: 'all', label: 'Everyone' },
  { value: 'recruiters', label: 'Recruiters' },
  { value: 'engaged', label: 'In conversation' },
  { value: 'not-contacted', label: 'Not contacted' },
] as const

function People() {
  const raw = Route.useSearch()
  const search = { ...raw, view: raw.view ?? 'all' } as const
  const navigate = useNavigate({ from: '/people/' })
  const drafting = search.view === 'drafts'
  const { data } = useQuery({ ...qo.people({ ...search, view: drafting ? 'all' : (search.view as PeopleView) }), enabled: !drafting })
  // Unsent drafts come with Today's data, already joined to their person.
  const { data: today } = useQuery({ ...qo.today(), enabled: drafting })
  const [q, setQ] = useState(search.q ?? '')
  const [adding, setAdding] = useState(false)
  useEffect(() => {
    const t = setTimeout(() => {
      if ((search.q ?? '') !== q) void navigate({ search: (s) => ({ ...s, q: q || undefined }), replace: true })
    }, 250)
    return () => clearTimeout(t)
  }, [q, search.q, navigate])
  return (
    <div>
      <PageHeader
        title="People"
        subtitle="Recruiters, hiring managers, founders and referrals, and when to follow up with each."
        actions={
          <Button size="sm" onClick={() => setAdding(true)}>
            <Plus /> Add
          </Button>
        }
      />
      <div className="mb-4 space-y-2">
        <div className="relative">
          <Search className="absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search name, company, title, email…" className="pl-9" />
        </div>
        <div className="overflow-x-auto scrollbar-none">
          <Segmented value={search.view} options={VIEWS} onChange={(v) => void navigate({ search: (s) => ({ ...s, view: v }), replace: true })} />
        </div>
      </div>
      {drafting ? (
        today?.drafts.length ? (
          <div className="space-y-2">
            {today.drafts.map((x) => (
              <DraftCard key={x.draft.id} d={{ ...x.draft, composeUrl: x.composeUrl, linkedinUrl: x.linkedinUrl, xUrl: x.xUrl, emailNote: x.emailNote }} personName={x.personName} />
            ))}
          </div>
        ) : (
          <Empty>No drafts waiting. When your AI writes outreach, it shows up here to review and send.</Empty>
        )
      ) : data?.people.length ? (
        <div className="grid grid-cols-1 gap-2 lg:grid-cols-2">
          {data.people.map((p) => (
            <PersonRow key={p.id} p={p} extra={data.draftCount[p.id] ? <span className="text-[11px] text-primary">{data.draftCount[p.id]} draft</span> : undefined} />
          ))}
        </div>
      ) : (
        <Empty>{search.view === 'due' ? 'No follow-ups due.' : search.view === 'all' && !search.q ? 'No one yet. People come in when your AI researches an application, or add someone you know.' : 'No one matches.'}</Empty>
      )}
      <PersonDialog open={adding} onOpenChange={setAdding} onSaved={(id) => void navigate({ to: '/people/$id', params: { id } })} />
    </div>
  )
}
