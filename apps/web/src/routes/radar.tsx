import { useSuspenseQuery } from '@tanstack/react-query'
import { createFileRoute } from '@tanstack/react-router'
import { Eye, Heart, Radar as RadarIcon, Sparkles, UserSearch } from 'lucide-react'
import { CompanyAvatar, Empty, PageHeader, Section } from '~/components/app/bits'
import { Badge } from '~/components/ui/badge'
import { Button } from '~/components/ui/button'
import { type listRadarFn, qo, setCompanyInterestFn, startTaskFn, watchCompanyFn } from '~/lib/api'
import { fmtDate } from '@sidedoor/shared/format'
import { useAction } from '~/lib/use-action'
import { cn } from '~/lib/utils'

export const Route = createFileRoute('/radar')({
  loader: ({ context }) => context.queryClient.ensureQueryData(qo.radar()),
  component: RadarPage,
})

type Co = Awaited<ReturnType<typeof listRadarFn>>['funded'][number]

function CompanyCard({ c }: { c: Co }) {
  const interest = useAction((v: { id: string; interest: number }) => setCompanyInterestFn({ data: v }))
  const watch = useAction((v: { id: string }) => watchCompanyFn({ data: v }), { success: (r) => `Watching their ${r.kind} board` })
  const task = useAction((v: { kind: 'custom'; instructions: string; title: string }) => startTaskFn({ data: v }), { success: 'Your AI is finding founders and emails' })
  return (
    <div className="rounded-xl border bg-card p-3.5">
      <div className="flex gap-3">
        <CompanyAvatar name={c.name} />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="truncate font-medium">{c.name}</span>
            {c.domain && (
              <a href={`https://${c.domain}`} target="_blank" rel="noreferrer" className="truncate text-xs text-muted-foreground hover:text-primary">
                {c.domain}
              </a>
            )}
          </div>
          {c.description && <p className="line-clamp-2 text-xs text-muted-foreground">{c.description}</p>}
          <div className="mt-1.5 flex flex-wrap items-center gap-1.5 text-xs">
            {c.fundingAmount && (
              <Badge variant="secondary">
                💸 {c.fundingAmount} {c.fundingStage}
              </Badge>
            )}
            {c.fundingAt && <span className="text-muted-foreground">{fmtDate(c.fundingAt)}</span>}
            {c.lanes.map((l) => (
              <Badge key={l} variant="outline" className="text-[11px]">
                {l}
              </Badge>
            ))}
            {c.watched && <Badge className="bg-success/20 text-success">watching jobs</Badge>}
            {c.people > 0 && <Badge variant="outline">{c.people} contacts</Badge>}
          </div>
        </div>
        <Button size="icon" variant="ghost" className={cn('size-8', c.interest >= 2 && 'text-hot')} onClick={() => void interest.run({ id: c.id, interest: c.interest >= 2 ? 1 : 2 })} aria-label="Dream company">
          <Heart className={cn(c.interest >= 2 && 'fill-current')} />
        </Button>
      </div>
      {c.fundingNote && <p className="mt-2 text-[13px] text-foreground/85">{c.fundingNote}</p>}
      <div className="mt-2.5 flex flex-wrap gap-1.5">
        <Button
          size="sm"
          className="h-7"
          disabled={task.pending}
          onClick={() =>
            void task.run({
              kind: 'custom',
              title: `Founder outreach: ${c.name}`,
              instructions: `${c.name}${c.domain ? ` (${c.domain})` : ''} recently raised ${c.fundingAmount ?? ''} ${c.fundingStage ?? ''}. Startups hire right after funding, often before posting roles. Find the founders/CTO/VP Eng (and anyone leading engineering hiring), their emails (use find_email; record the company email pattern), add them with upsert_person (kind founder/hiring-manager, whyMd with the hook), save a short research brief for the company with save_research, then create_draft a short, specific email from me to the best person asking about engineering leadership / senior product engineering needs as they scale. Context on the company: ${c.fundingNote ?? c.description ?? ''}`,
            })
          }
        >
          <UserSearch /> Find founders + draft intro
        </Button>
        {!c.watched && (
          <Button size="sm" variant="outline" className="h-7" disabled={watch.pending} onClick={() => void watch.run({ id: c.id })}>
            <Eye /> Watch their job board
          </Button>
        )}
        {c.fundingUrl && (
          <Button asChild size="sm" variant="ghost" className="h-7">
            <a href={c.fundingUrl} target="_blank" rel="noreferrer">
              News
            </a>
          </Button>
        )}
      </div>
    </div>
  )
}

function RadarPage() {
  const { data } = useSuspenseQuery(qo.radar())
  const scan = useAction(() => startTaskFn({ data: { kind: 'funding' } }), { success: 'Scanning funding news' })
  const discover = useAction(() => startTaskFn({ data: { kind: 'discover' } }), { success: 'Your AI is looking for new companies and boards' })
  return (
    <div className="space-y-7">
      <PageHeader
        title="Funding radar"
        subtitle="Startups that just raised money hire within weeks, often before a role is posted. Reach the founder first."
        actions={
          <>
            <Button size="sm" variant="outline" onClick={() => void discover.run(undefined)} disabled={discover.pending}>
              <Sparkles /> Discover companies
            </Button>
            <Button size="sm" onClick={() => void scan.run(undefined)} disabled={scan.pending}>
              <RadarIcon /> Scan funding news
            </Button>
          </>
        }
      />
      <Section title="Recently funded, in industries you like" count={data.funded.length}>
        {data.funded.length ? (
          <div className="grid grid-cols-1 gap-2 lg:grid-cols-2">
            {data.funded.map((c) => (
              <CompanyCard key={c.id} c={c} />
            ))}
          </div>
        ) : (
          <Empty>The radar scans TechCrunch, Crunchbase News, FinSMEs and The Block every few hours. Hit “Scan funding news” to run it now.</Empty>
        )}
      </Section>
      {data.dream.length > 0 && (
        <Section title="Dream & interested companies" count={data.dream.length}>
          <p className="-mt-1 px-1 text-xs text-muted-foreground">♥ dream companies have their boards polled every few minutes so you hear about new roles first.</p>
          <div className="grid grid-cols-1 gap-2 lg:grid-cols-2">
            {data.dream.map((c) => (
              <CompanyCard key={c.id} c={c} />
            ))}
          </div>
        </Section>
      )}
    </div>
  )
}
