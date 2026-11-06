import { useSuspenseQuery } from '@tanstack/react-query'
import { createFileRoute } from '@tanstack/react-router'
import { useState } from 'react'
import { z } from 'zod'
import { Empty, PageHeader } from '~/components/app/bits'
import { QuestionList } from '~/components/app/questions'
import { Segmented } from '~/components/app/segmented'
import { usePageContext } from '~/components/app/chat'
import { qo } from '~/lib/api'

const STATUS = ['open', 'answered', 'dismissed'] as const
const ABOUT = ['all', 'you', 'application'] as const

export const Route = createFileRoute('/questions')({
  validateSearch: z.object({ status: z.enum(STATUS).optional().catch(undefined), about: z.enum(ABOUT).optional().catch(undefined) }),
  loaderDeps: ({ search }) => ({ status: search.status ?? 'open', about: search.about ?? 'all' }),
  loader: ({ context, deps }) => context.queryClient.ensureQueryData(qo.questions({ status: deps.status, ...(deps.about !== 'all' ? { about: deps.about } : {}) })),
  component: Questions,
})

/** Every question your AI or a form asked that only you can answer, across applications. */
function Questions() {
  const search = Route.useSearch()
  const navigate = Route.useNavigate()
  const status = search.status ?? 'open'
  const about = search.about ?? 'all'
  const { data } = useSuspenseQuery(qo.questions({ status, ...(about !== 'all' ? { about } : {}) }))
  const [showOptional, setShowOptional] = useState(false)
  usePageContext('/questions', `questions for the user (${status})`)
  const needed = data.filter((g) => !(g.status === 'open' && g.optional))
  const optional = data.filter((g) => g.status === 'open' && g.optional)
  return (
    <div>
      <PageHeader title="Questions" subtitle="Things only you can answer. Answers about you can count for every application, so they aren't asked again." />
      <div className="mb-4 flex flex-wrap gap-2">
        <Segmented
          value={status}
          onChange={(v) => void navigate({ search: (s) => ({ ...s, status: v }), replace: true })}
          options={[
            { value: 'open', label: 'Open' },
            { value: 'answered', label: 'Answered' },
            { value: 'dismissed', label: 'Not needed' },
          ]}
        />
        <Segmented
          value={about}
          onChange={(v) => void navigate({ search: (s) => ({ ...s, about: v }), replace: true })}
          options={[
            { value: 'all', label: 'All' },
            { value: 'you', label: 'About you' },
            { value: 'application', label: 'About an application' },
          ]}
        />
      </div>
      {needed.length ? <QuestionList groups={needed} /> : <Empty>{status === 'open' ? 'Nothing needs an answer right now.' : 'None yet.'}</Empty>}
      {optional.length > 0 && (
        <div className="mt-4 space-y-2">
          <button type="button" className="text-sm text-muted-foreground hover:text-foreground" onClick={() => setShowOptional(!showOptional)}>
            {showOptional ? 'Hide' : 'Show'} {optional.length} optional. They could strengthen an application, but nothing waits on them.
          </button>
          {showOptional && <QuestionList groups={optional} />}
        </div>
      )}
    </div>
  )
}
