import { createFileRoute } from '@tanstack/react-router'
import { ResumeEditor } from '~/components/resume/editor'
import { qo } from '~/lib/api'

export const Route = createFileRoute('/resume/$id')({
  loader: ({ context, params }) => context.queryClient.ensureQueryData(qo.resume(params.id)),
  component: () => {
    const { id } = Route.useParams()
    return <ResumeEditor key={id} resumeId={id} />
  },
})
