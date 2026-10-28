import { useSuspenseQuery } from '@tanstack/react-query'
import { createFileRoute, Link } from '@tanstack/react-router'
import { BookOpen, Briefcase, ChevronRight, ClipboardList, FileText, PenLine, ShieldCheck, Target } from 'lucide-react'
import { TimeAgo } from '~/components/app/bits'
import { qo } from '~/lib/api'

export const Route = createFileRoute('/profile/')({
  loader: ({ context }) => Promise.all([context.queryClient.ensureQueryData(qo.docs()), context.queryClient.ensureQueryData(qo.resumes())]),
  component: Profile,
})

const ICONS = { experience: Briefcase, search: Target, answers: ClipboardList, writing: PenLine, stories: BookOpen, tells: ShieldCheck } as const

/** Everything your AI knows about you, in one place. */
function Profile() {
  const { data: docs } = useSuspenseQuery(qo.docs())
  const { data: resumes } = useSuspenseQuery(qo.resumes())
  const main = resumes.find((r) => r.kind === 'base')
  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Profile</h1>
        <p className="mt-0.5 max-w-prose text-sm text-muted-foreground">Everything your AI knows about you. It uses only these facts when it writes for you, so the more complete your Experience is, the better everything else gets.</p>
      </div>
      <div className="divide-y rounded-xl border">
        <Link to={main ? '/resume/$id' : '/resume'} params={main ? { id: main.id } : {}} className="flex items-center gap-4 p-4 transition-colors hover:bg-muted/40">
          <FileText className="size-5 shrink-0 text-muted-foreground" />
          <div className="min-w-0 flex-1">
            <div className="font-medium">Resume</div>
            <div className="text-sm text-muted-foreground">{main ? main.title : 'Not created yet'}</div>
          </div>
          <ChevronRight className="size-4 text-muted-foreground" />
        </Link>
        {docs.map((d) => {
          const Icon = ICONS[d.key as keyof typeof ICONS] ?? FileText
          const to = d.key === 'stories' ? '/stories' : '/profile/$key'
          return (
            <Link key={d.key} to={to} params={d.key === 'stories' ? {} : { key: d.key }} className="flex items-center gap-4 p-4 transition-colors hover:bg-muted/40">
              <Icon className="size-5 shrink-0 text-muted-foreground" />
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2 font-medium">
                  {d.title}
                  {!d.written && d.key !== 'tells' && <span className="rounded-md bg-hot/15 px-1.5 py-0.5 text-[11px] font-medium text-hot">Not filled in</span>}
                </div>
                <div className="text-sm text-muted-foreground">{d.hint}</div>
              </div>
              {d.updatedAt && <TimeAgo iso={d.updatedAt} className="text-xs text-muted-foreground" />}
              <ChevronRight className="size-4 text-muted-foreground" />
            </Link>
          )
        })}
      </div>
    </div>
  )
}
