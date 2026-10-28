import { createFileRoute } from '@tanstack/react-router'
import { ChatLayout } from '~/components/app/chat-layout'
import { qo } from '~/lib/api'

export const Route = createFileRoute('/chat/')({
  loader: ({ context }) => context.queryClient.ensureQueryData(qo.threads()),
  component: ChatIndex,
})

function ChatIndex() {
  return <ChatLayout threadId={null} />
}
