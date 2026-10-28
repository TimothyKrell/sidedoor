import { useSuspenseQuery } from '@tanstack/react-query'
import { useState } from 'react'
import { createFileRoute, Link, useNavigate } from '@tanstack/react-router'
import { Bot, ExternalLink, Rocket, Star, X } from 'lucide-react'
import { CompanyAvatar, Empty, FitBadge, Freshness, LocationNote, Section, StageBadge } from '~/components/app/bits'
import { PersonRow } from '~/components/app/cards'
import { useChat, usePageContext } from '~/components/app/chat'
import { Badge } from '~/components/ui/badge'
import { Button } from '~/components/ui/button'
import { Card, CardContent } from '~/components/ui/card'
import { qo, setPostingStatusFn, trackPostingFn } from '~/lib/api'
import { fmtDate } from '@sidedoor/shared/format'
import { useAction } from '~/lib/use-action'
import { cn } from '~/lib/utils'

export const Route = createFileRoute('/jobs/$id')({
  loader: ({ context, params }) => context.queryClient.ensureQueryData(qo.posting(params.id)),
  component: Job,
})

function Job() {
  const { id } = Route.useParams()
  const { data } = useSuspenseQuery(qo.posting(id))
  const navigate = useNavigate()
  const chat = useChat()
  const p = data?.posting
  usePageContext(`/jobs/${id}`, p ? `posting ${p.companyName} – ${p.title}` : undefined)
  const track = useAction((d: { id: string; prep?: boolean; research?: boolean }) => trackPostingFn({ data: d }), { success: 'Tracking it' })
  const status = useAction((d: { id: string; status: 'new' | 'starred' | 'dismissed' }) => setPostingStatusFn({ data: d }))
  if (!data || !p) return <Empty>Posting not found.</Empty>

  const go = async (prep: boolean, research: boolean) => {
    const r = await track.run({ id: p.id, prep, research })
    if (r) void navigate({ to: '/applications/$id', params: { id: r.id } })
  }

  return (
    <div className="space-y-6">
      <div className="flex gap-3">
        <CompanyAvatar name={p.companyName} className="size-12 text-lg" />
        <div className="min-w-0 flex-1">
          <h1 className="text-xl font-semibold leading-tight tracking-tight md:text-2xl">{p.title}</h1>
          <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-sm text-muted-foreground">
            <span className="text-foreground">{p.companyName}</span>
            <span>·</span>
            <span>{p.location?.replace(/\s*\|\s*/g, ' · ') || 'Location n/a'}</span>
            {p.compText && (
              <>
                <span>·</span>
                <span>{p.compText}</span>
              </>
            )}
          </div>
          <div className="mt-1.5 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
            <Freshness postedAt={p.postedAt} firstSeenAt={p.firstSeenAt} />
            <span>{p.postedAt ? `posted ${fmtDate(p.postedAt)}` : 'no posted date from the board'} · first seen {fmtDate(p.firstSeenAt)}</span>
            {data.source && <Badge variant="outline">{data.source.name}</Badge>}
            {p.viaUrl && (
              <a href={p.viaUrl} target="_blank" rel="noreferrer" className="underline-offset-2 hover:underline">
                found via {new URL(p.viaUrl).hostname.replace(/^www\./, '')}
              </a>
            )}
            {p.closedAt && <Badge variant="destructive">Closed {fmtDate(p.closedAt)}</Badge>}
          </div>
          <LocationNote fit={p.locationFit} note={p.locationNote} />
        </div>
      </div>

      <div className="flex flex-wrap gap-2">
        {p.applicationId ? (
          <Button asChild>
            <Link to="/applications/$id" params={{ id: p.applicationId }}>
              Open application
            </Link>
          </Button>
        ) : (
          <>
            <Button disabled={track.pending} onClick={() => void go(true, true)}>
              <Rocket /> Go after it
            </Button>
            <Button variant="secondary" disabled={track.pending} onClick={() => void go(false, true)}>
              Research first
            </Button>
            <Button variant="outline" disabled={track.pending} onClick={() => void go(false, false)}>
              Just track
            </Button>
          </>
        )}
        {(p.applyUrl ?? p.url) && (
          <Button asChild variant="outline">
            <a href={(p.applyUrl ?? p.url)!} target="_blank" rel="noreferrer">
              <ExternalLink /> Posting
            </a>
          </Button>
        )}
        <Button variant="ghost" size="icon" className={cn(p.userStatus === 'starred' && 'text-primary')} onClick={() => void status.run({ id: p.id, status: p.userStatus === 'starred' ? 'new' : 'starred' })} aria-label="Star">
          <Star className={cn(p.userStatus === 'starred' && 'fill-current')} />
        </Button>
        {!p.applicationId && (
          <Button variant="ghost" size="icon" onClick={() => void status.run({ id: p.id, status: 'dismissed' })} aria-label="Dismiss">
            <X />
          </Button>
        )}
        <Button variant="ghost" onClick={() => chat.openChat()}>
          <Bot /> Ask your AI
        </Button>
      </div>
      <p className="-mt-3 text-xs text-muted-foreground">
        <b>Go after it</b>: your AI tailors your resume and answers (for your review) and researches the company, the hiring manager, and their emails.
      </p>

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-[minmax(0,1fr)_320px]">
        <div className="space-y-6">
          {p.summary && (
            <Card>
              <CardContent className="space-y-3 text-sm">
                <div className="flex items-center gap-2">
                  <FitBadge fit={p.fitScore} />
                  <span className="font-medium">{p.lane ?? 'Fit'}</span>
                  {p.decision && <Badge variant="secondary">{p.decision === 'queue' ? 'strong fit' : p.decision}</Badge>}
                </div>
                <p>{p.summary}</p>
                {!!p.reasons?.length && (
                  <div>
                    <div className="mb-1 text-xs font-medium text-success">Why it fits</div>
                    <ul className="list-disc space-y-0.5 pl-5 text-muted-foreground">
                      {p.reasons.map((r) => (
                        <li key={r}>{r}</li>
                      ))}
                    </ul>
                  </div>
                )}
                {!!p.gaps?.length && (
                  <div>
                    <div className="mb-1 text-xs font-medium text-hot">Gaps</div>
                    <ul className="list-disc space-y-0.5 pl-5 text-muted-foreground">
                      {p.gaps.map((r) => (
                        <li key={r}>{r}</li>
                      ))}
                    </ul>
                  </div>
                )}
              </CardContent>
            </Card>
          )}
          <Section title="Job description">
            <JobText text={p.jd} />
          </Section>
        </div>
        <div className="space-y-6">
          {data.company && (
            <Section title={data.company.name}>
              <div className="space-y-1.5 rounded-xl border bg-card p-3.5 text-sm">
                {data.company.description && <p className="text-muted-foreground">{data.company.description}</p>}
                {data.company.domain && (
                  <a className="block text-primary" href={`https://${data.company.domain}`} target="_blank" rel="noreferrer">
                    {data.company.domain}
                  </a>
                )}
                {data.company.fundingAmount && (
                  <p className="text-xs">
                    💸 {data.company.fundingAmount} {data.company.fundingStage} · {fmtDate(data.company.fundingAt)}
                  </p>
                )}
                {data.company.emailPattern && <p className="text-xs text-muted-foreground">Email pattern: {data.company.emailPattern}</p>}
              </div>
            </Section>
          )}
          {data.applicationsAtCompany.length > 0 && (
            <Section title="Your applications here">
              <div className="space-y-1.5">
                {data.applicationsAtCompany.map((a) => (
                  <Link key={a.id} to="/applications/$id" params={{ id: a.id }} className="flex items-center justify-between gap-2 rounded-lg border bg-card px-3 py-2 text-sm hover:border-primary/40">
                    <span className="truncate">{a.role}</span>
                    <StageBadge stage={a.stage} />
                  </Link>
                ))}
              </div>
              <p className="px-1 text-xs text-muted-foreground">Some employers auto-reject multiple applications. Check before applying twice.</p>
            </Section>
          )}
          {data.peopleAtCompany.length > 0 && (
            <Section title="People you know here">
              <div className="space-y-1.5">
                {data.peopleAtCompany.map((x) => (
                  <PersonRow key={x.id} p={x} />
                ))}
              </div>
            </Section>
          )}
        </div>
      </div>
    </div>
  )
}

/** The posting as boards send it, tidied: no runs of blank lines, long ones folded. */
function JobText({ text }: { text: string | null }) {
  const [all, setAll] = useState(false)
  const clean = (text ?? '').replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim()
  if (!clean) return <div className="rounded-xl border bg-card p-4 text-sm text-muted-foreground">No description captured. Open the posting.</div>
  const long = clean.split('\n').length > 14 || clean.length > 1400
  return (
    <div className="rounded-xl border bg-card p-4">
      <div className={cn('text-sm leading-relaxed whitespace-pre-line text-foreground/90', long && !all && 'line-clamp-[14]')}>{clean}</div>
      {long && (
        <button type="button" onClick={() => setAll(!all)} className="mt-2 text-sm font-medium text-primary hover:underline">
          {all ? 'Show less' : 'Show full description'}
        </button>
      )}
    </div>
  )
}

