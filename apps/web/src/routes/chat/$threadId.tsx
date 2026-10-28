import { createFileRoute } from '@tanstack/react-router'
import { qo } from '~/lib/api'
import { ChatLayout } from '~/components/app/chat-layout'

export const Route = createFileRoute('/chat/$threadId')({
  loader: async ({ context, params }) => {
    await Promise.all([context.queryClient.ensureQueryData(qo.threads()), context.queryClient.ensureQueryData(qo.thread(params.threadId))])
  },
  component: Thread,
})

function Thread() {
  const { threadId } = Route.useParams()
  return <ChatLayout threadId={threadId} />
}
