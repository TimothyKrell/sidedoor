import { useSuspenseQuery } from '@tanstack/react-query'
import { Link, useNavigate } from '@tanstack/react-router'
import { MessageSquare } from 'lucide-react'
import { qo } from '~/lib/api'
import { TimeAgo } from './bits'
import { ChatView } from './chat'

export function ThreadList({ active }: { active?: string }) {
  const { data } = useSuspenseQuery(qo.threads())
  return (
    <div className="space-y-0.5">
      <Link to="/chat" className="block rounded-lg px-3 py-2 text-sm font-medium text-primary hover:bg-accent">
        + New chat
      </Link>
      {data.map((t) => (
        <Link key={t.id} to="/chat/$threadId" params={{ threadId: t.id }} className={`flex items-center gap-2 rounded-lg px-3 py-2 text-sm hover:bg-accent ${t.id === active ? 'bg-accent' : ''}`}>
          <MessageSquare className="size-3.5 shrink-0 text-muted-foreground" />
          <span className="min-w-0 flex-1 truncate">{t.title}</span>
          <TimeAgo iso={t.updatedAt} className="shrink-0 text-[11px] text-muted-foreground" />
        </Link>
      ))}
    </div>
  )
}

export function ChatLayout({ threadId }: { threadId: string | null }) {
  const navigate = useNavigate()
  return (
    <div className="-mx-4 -mt-5 -mb-28 flex h-[calc(100dvh-53px-64px)] md:-mx-8 md:-mt-8 md:-mb-10 md:h-dvh">
      <aside className="hidden w-64 shrink-0 overflow-y-auto border-r p-2 lg:block">
        <ThreadList active={threadId ?? undefined} />
      </aside>
      <ChatView key={threadId ?? 'new'} threadId={threadId} onThread={(id) => void navigate({ to: '/chat/$threadId', params: { threadId: id } })} className="mx-auto w-full max-w-3xl flex-1" autoFocus />
    </div>
  )
}
