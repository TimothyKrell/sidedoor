import { useSuspenseQuery } from '@tanstack/react-query'
import { createFileRoute, Link, useNavigate } from '@tanstack/react-router'
import { BookOpen, ChevronRight, Hash, Loader2, MessageSquare, Mic } from 'lucide-react'
import { useMemo, useState } from 'react'
import { CopyButton, Empty, Markdown, PageHeader, Section, TimeAgo } from '~/components/app/bits'
import { Button } from '~/components/ui/button'
import { Input } from '~/components/ui/input'
import { qo, startStoryInterviewFn } from '~/lib/api'
import { useAction } from '~/lib/use-action'
import { cn } from '~/lib/utils'

export const Route = createFileRoute('/stories')({
  loader: ({ context }) => context.queryClient.ensureQueryData(qo.stories()),
  component: StoriesPage,
})

type Data = Awaited<ReturnType<NonNullable<ReturnType<typeof qo.stories>['queryFn']>>>
type Seed = Data['seeds'][number]

const readyToUse = (body: string) => /### Ready to use\s*\n([\s\S]*?)(?=\n### |\n## |$)/.exec(body)?.[1]?.trim() ?? null

function StoriesPage() {
  const { data } = useSuspenseQuery(qo.stories())
  const navigate = useNavigate()
  const [topic, setTopic] = useState('')
  const start = useAction((v: { seed?: string; role?: string }) => startStoryInterviewFn({ data: v }))
  const go = async (v: { seed?: string; role?: string }) => {
    const r = await start.run(v)
    if (r?.threadId) void navigate({ to: '/chat/$threadId', params: { threadId: r.threadId } })
  }
  const groups = useMemo(() => {
    const m = new Map<string, Seed[]>()
    for (const s of data.seeds) m.set(s.role, [...(m.get(s.role) ?? []), s])
    return [...m.entries()]
  }, [data.seeds])

  return (
    <div className="space-y-6">
      <PageHeader
        title="Story bank"
        subtitle="Specific stories in your own words, the material AI can't invent. Your AI interviews you one question at a time and saves the story to your story bank."
      />

      <div className="space-y-3 rounded-xl border border-primary/40 bg-card p-4">
        <div className="flex flex-wrap gap-2">
          <Button disabled={start.pending} onClick={() => void go({})}>
            {start.pending ? <Loader2 className="animate-spin" /> : <Mic />} Interview me
          </Button>
          <span className="self-center text-xs text-muted-foreground">Your AI picks an achievement from your experience.</span>
        </div>
        <form
          className="flex gap-2"
          onSubmit={(e) => {
            e.preventDefault()
            if (topic.trim()) void go({ seed: topic.trim() })
          }}
        >
          <Input value={topic} onChange={(e) => setTopic(e.target.value)} placeholder="Or a story of your own, e.g. “the night the Blackhole migration almost slipped”" className="h-9" />
          <Button type="submit" variant="secondary" disabled={!topic.trim() || start.pending}>
            Start
          </Button>
        </form>
      </div>

      {data.threads.length > 0 && (
        <Section title="Interviews" count={data.threads.length}>
          <div className="space-y-1">
            {data.threads.slice(0, 6).map((t) => (
              <Link key={t.id} to="/chat/$threadId" params={{ threadId: t.id }} className="flex items-center gap-2 rounded-lg border bg-card px-3 py-2 text-sm hover:border-primary/40">
                <MessageSquare className="size-3.5 shrink-0 text-muted-foreground" />
                <span className="min-w-0 flex-1 truncate">{t.title.replace(/^Story: /, '')}</span>
                <TimeAgo iso={t.updatedAt} className="shrink-0 text-[11px] text-muted-foreground" />
              </Link>
            ))}
          </div>
        </Section>
      )}

      <Section title="Stories" count={data.stories.length}>
        {data.stories.length ? (
          <div className="space-y-2">
            {data.stories.map((s) => (
              <StoryCard key={s.title} title={s.title} body={s.body} />
            ))}
          </div>
        ) : (
          <Empty>
            No stories yet. Start with “Interview me”, or pick an idea below.
          </Empty>
        )}
      </Section>

      <Section title="Ideas from your experience" count={data.seeds.length}>
        {groups.length ? (
          <div className="space-y-2">
            {groups.map(([role, seeds], i) => (
              <SeedGroup key={role} role={role} seeds={seeds} defaultOpen={i === 0} onPick={(s) => void go({ seed: s.text, role: `${s.role}${s.date ? `, ${s.date}` : ''}` })} disabled={start.pending} />
            ))}
          </div>
        ) : (
          <Empty>career-inventory.md not found.</Empty>
        )}
      </Section>
    </div>
  )
}

function StoryCard({ title, body }: { title: string; body: string }) {
  const [open, setOpen] = useState(false)
  const ready = readyToUse(body)
  return (
    <div className="rounded-xl border bg-card p-3.5">
      <button type="button" onClick={() => setOpen(!open)} className="flex w-full items-start gap-2 text-left">
        <BookOpen className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
        <span className="min-w-0 flex-1 text-sm font-medium">{title}</span>
        <ChevronRight className={cn('mt-0.5 size-4 shrink-0 text-muted-foreground transition-transform', open && 'rotate-90')} />
      </button>
      {ready && !open && <p className="mt-2 line-clamp-3 text-[13px] text-muted-foreground">{ready}</p>}
      {open && (
        <div className="mt-3">
          <Markdown>{body}</Markdown>
        </div>
      )}
      {ready && (
        <div className="mt-2">
          <CopyButton text={ready} label="Copy ready-to-use" className="h-7" />
        </div>
      )}
    </div>
  )
}

function SeedGroup({ role, seeds, defaultOpen, onPick, disabled }: { role: string; seeds: Seed[]; defaultOpen: boolean; onPick: (s: Seed) => void; disabled: boolean }) {
  const [open, setOpen] = useState(defaultOpen)
  return (
    <div className="rounded-xl border bg-card">
      <button type="button" onClick={() => setOpen(!open)} className="flex min-h-11 w-full items-center gap-2 px-3.5 py-2 text-left">
        <ChevronRight className={cn('size-4 shrink-0 text-muted-foreground transition-transform', open && 'rotate-90')} />
        <span className="min-w-0 flex-1 truncate text-sm font-medium">{role}</span>
        <span className="shrink-0 text-xs text-muted-foreground">{seeds[0]?.date}</span>
      </button>
      {open && (
        <ul className="divide-y border-t">
          {seeds.map((s, i) => (
            <li key={i}>
              <button type="button" disabled={disabled} onClick={() => onPick(s)} className="flex w-full items-start gap-2 px-3.5 py-2.5 text-left text-[13px] hover:bg-accent disabled:opacity-60">
                {s.hasNumber ? <Hash className="mt-0.5 size-3.5 shrink-0 text-primary" aria-label="has a number" /> : <span className="size-3.5 shrink-0" />}
                <span className="min-w-0 flex-1 line-clamp-3">{s.text}</span>
                <Mic className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" />
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
