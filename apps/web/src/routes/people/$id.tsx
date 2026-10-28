import { useSuspenseQuery } from '@tanstack/react-query'
import { createFileRoute, Link } from '@tanstack/react-router'
import { AtSign, Bot, Link2, Mail, MailX, Pencil, Sparkles } from 'lucide-react'
import { useState } from 'react'
import { CopyButton, Empty, Markdown, Section, StageBadge, TimeAgo } from '~/components/app/bits'
import { DraftCard } from '~/components/app/cards'
import { useChat, usePageContext } from '~/components/app/chat'
import { FollowupPicker, InteractionForm, PersonDialog } from '~/components/app/forms'
import { Badge } from '~/components/ui/badge'
import { Button } from '~/components/ui/button'
import { Input } from '~/components/ui/input'
import { emailBouncedFn, findEmailFn, type getPersonFn, qo, savePersonFn, startTaskFn } from '~/lib/api'
import { fmtDate, PERSON_KIND_LABEL, RELATIONSHIP_LABEL } from '@sidedoor/shared/format'
import { linkedinUrl } from '@sidedoor/shared/linkedin'
import { xHandle, xUrl } from '@sidedoor/shared/x'
import { useAction } from '~/lib/use-action'

export const Route = createFileRoute('/people/$id')({
  loader: ({ context, params }) => context.queryClient.ensureQueryData(qo.person(params.id)),
  component: PersonPage,
})

function PersonPage() {
  const { id } = Route.useParams()
  const { data } = useSuspenseQuery(qo.person(id))
  const chat = useChat()
  const p = data?.person
  usePageContext(`/people/${id}`, p ? `contact ${p.name}${p.companyName ? ` at ${p.companyName}` : ''}` : undefined)
  const [editing, setEditing] = useState(false)
  const [appId, setAppId] = useState<string | null>(null)
  const task = useAction((v: { kind: 'outreach'; personId: string; applicationId?: string; instructions?: string }) => startTaskFn({ data: v }), { success: 'Your AI is drafting. You’ll get a notification when it’s ready.' })
  if (!data || !p) return <Empty>Not found.</Empty>
  const drafts = data.drafts.filter((d) => d.status === 'draft')
  const sent = data.drafts.filter((d) => d.status === 'sent')
  const contacted = p.stage !== 'not-contacted'
  const openApps = data.applications.filter((a) => a.stage !== 'closed')
  const forApp = data.applications.find((a) => a.id === appId) ?? openApps[0] ?? data.applications[0]

  return (
    <div className="space-y-6">
      <div className="flex gap-3">
        <span className="flex size-12 shrink-0 items-center justify-center rounded-full bg-secondary text-base font-semibold">
          {p.name
            .split(/\s+/)
            .map((x) => x[0])
            .slice(0, 2)
            .join('')}
        </span>
        <div className="min-w-0 flex-1">
          <h1 className="text-xl font-semibold tracking-tight md:text-2xl">{p.name}</h1>
          <div className="text-sm text-muted-foreground">{[p.title, p.companyName].filter(Boolean).join(' · ')}</div>
          <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
            <Badge variant="secondary">{PERSON_KIND_LABEL[p.kind] ?? p.kind}</Badge>
            <Badge variant="outline">{RELATIONSHIP_LABEL[p.stage] ?? p.stage}</Badge>
            {p.priority === 'high' && <Badge variant="outline" className="border-primary/50 text-primary">high priority</Badge>}
            {p.lastContactAt && (
              <span className="text-xs text-muted-foreground">
                last contact <TimeAgo iso={p.lastContactAt} />
              </span>
            )}
          </div>
        </div>
        <Button size="icon" variant="ghost" onClick={() => setEditing(true)} aria-label="Edit">
          <Pencil />
        </Button>
      </div>

      <div className="flex flex-wrap gap-2">
        <FollowupPicker date={p.nextContactAt} personId={p.id} />
        {/* One draft at a time: an unsent one is waiting below. */}
        {drafts.length === 0 && (
          <span className="inline-flex items-center gap-1.5">
            <Button size="sm" variant="outline" className="h-8" onClick={() => void task.run({ kind: 'outreach', personId: p.id, ...(forApp ? { applicationId: forApp.id } : {}), ...(contacted ? { instructions: 'This is a follow-up; they have not replied to the last message.' } : {}) })} disabled={task.pending}>
              <Sparkles /> {contacted ? 'Draft follow-up' : 'Draft first message'}
            </Button>
            {openApps.length > 1 && (
              <select aria-label="About which application" value={forApp?.id ?? ''} onChange={(e) => setAppId(e.target.value)} className="h-8 max-w-56 truncate rounded-md border border-input bg-transparent px-2 text-xs">
                {openApps.map((a) => (
                  <option key={a.id} value={a.id}>
                    about {a.role}
                  </option>
                ))}
              </select>
            )}
          </span>
        )}
        {linkedinUrl(p) && (
          <Button asChild size="sm" variant="outline" className="h-8" title={p.linkedin ? undefined : 'No profile saved yet: searches LinkedIn. Paste their profile URL via Edit to save it.'}>
            <a href={linkedinUrl(p)!} target="_blank" rel="noreferrer">
              <Link2 /> {p.linkedin ? 'LinkedIn' : 'Find on LinkedIn'}
            </a>
          </Button>
        )}
        {xUrl(p.x) && (
          <Button asChild size="sm" variant="outline" className="h-8">
            <a href={xUrl(p.x)!} target="_blank" rel="noreferrer">
              <AtSign /> {xHandle(p.x)}
            </a>
          </Button>
        )}
        <Button size="sm" variant="ghost" className="h-8" onClick={() => chat.openChat()}>
          <Bot /> Ask your AI
        </Button>
      </div>
      {p.nextAction && <div className="-mt-3 text-sm text-muted-foreground">→ {p.nextAction}</div>}

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-[minmax(0,1fr)_340px]">
        <div className="space-y-6">
          {drafts.length > 0 && (
            <Section title="Drafts" count={drafts.length}>
              <div className="space-y-2">
                {drafts.map((d) => (
                  <DraftCard key={d.id} d={d} personName={p.name} />
                ))}
              </div>
            </Section>
          )}
          <Section title="Log a touchpoint">
            <InteractionForm personId={p.id} {...(forApp ? { applicationId: forApp.id } : {})} defaultCadence={p.cadenceDays ?? 7} />
          </Section>
          <Section title="History">
            {data.interactions.length ? (
              <div className="space-y-1.5">
                {data.interactions.map((i) => (
                  <div key={i.id} className="flex gap-3 rounded-lg border bg-card px-3 py-2 text-sm">
                    <span className="w-16 shrink-0 text-xs text-muted-foreground">{fmtDate(i.at)}</span>
                    <span className="w-16 shrink-0 text-xs text-muted-foreground">
                      {i.direction === 'in' ? '←' : i.direction === 'out' ? '→' : '•'} {i.channel}
                    </span>
                    <span className="min-w-0">{i.summary}</span>
                  </div>
                ))}
              </div>
            ) : (
              <Empty>No contact yet.</Empty>
            )}
          </Section>
          {sent.length > 0 && (
            <Section title="Sent messages">
              <div className="space-y-2">
                {sent.map((d) => (
                  <DraftCard key={d.id} d={d} personName={p.name} />
                ))}
              </div>
            </Section>
          )}
          {p.notesMd && (
            <Section title="Notes">
              <div className="rounded-xl border bg-card p-4">
                <Markdown>{p.notesMd}</Markdown>
              </div>
            </Section>
          )}
        </div>
        <div className="space-y-6">
          <EmailBox p={p} domain={data.company?.domain ?? null} pattern={data.company?.emailPattern ?? null} />
          {p.whyMd && (
            <Section title="Why they matter">
              <div className="rounded-xl border bg-card p-3.5">
                <Markdown>{p.whyMd}</Markdown>
              </div>
            </Section>
          )}
          {data.applications.length > 0 && (
            <Section title="Applications">
              <div className="space-y-1.5">
                {data.applications.map((a) => (
                  <Link key={a.id} to="/applications/$id" params={{ id: a.id }} className="flex items-start justify-between gap-2 rounded-lg border bg-card px-3 py-2 text-sm hover:border-primary/40">
                    <span className="min-w-0">
                      <span className="line-clamp-2">{a.role}</span>
                      <span className="block truncate text-xs text-muted-foreground">{a.companyName}</span>
                    </span>
                    <StageBadge stage={a.stage} />
                  </Link>
                ))}
              </div>
            </Section>
          )}
        </div>
      </div>
      <PersonDialog
        open={editing}
        onOpenChange={setEditing}
        initial={{ id: p.id, name: p.name, companyName: p.companyName ?? '', title: p.title ?? '', kind: p.kind, email: p.email ?? '', linkedin: p.linkedin ?? '', x: xHandle(p.x) ? `@${xHandle(p.x)}` : '', nextContactAt: p.nextContactAt ?? '', nextAction: p.nextAction ?? '', whyMd: p.whyMd ?? '' }}
      />
    </div>
  )
}

type P = NonNullable<Awaited<ReturnType<typeof getPersonFn>>>['person']

function EmailBox({ p, domain, pattern }: { p: P; domain: string | null; pattern: string | null }) {
  const [d, setD] = useState(domain ?? '')
  const find = useAction((v: { personId: string; domain: string }) => findEmailFn({ data: v }))
  const save = useAction((v: { id: string; name: string; email: string; emailConfidence: string }) => savePersonFn({ data: v }), { success: 'Email saved' })
  const [result, setResult] = useState<Awaited<ReturnType<typeof findEmailFn>> | null>(null)
  const bounced = useAction((v: { personId: string; email: string | null }) => emailBouncedFn({ data: v }), {
    success: (r) => (r.next ? `Next try: ${r.next.email} (${r.next.confidence})` : 'Marked as bounced. No other address found; try LinkedIn.'),
  })
  return (
    <Section title="Email">
      <div className="space-y-2.5 rounded-xl border bg-card p-3.5 text-sm">
        {p.email ? (
          <div className="flex items-center gap-2">
            <Mail className="size-4 text-muted-foreground" />
            <span className="min-w-0 flex-1 truncate">{p.email}</span>
            <Badge variant={p.emailConfidence === 'guessed' ? 'outline' : 'secondary'}>{p.emailConfidence ?? 'unknown'}</Badge>
            <CopyButton text={p.email} size="icon" className="size-7" />
            <Button size="icon" variant="ghost" className="size-7" title="It bounced: mark this address bad and find the next most likely one" disabled={bounced.pending} onClick={() => void bounced.run({ personId: p.id, email: p.email })}>
              <MailX />
            </Button>
          </div>
        ) : (
          <div className="text-muted-foreground">No email yet.</div>
        )}
        {p.emailSource && <div className="text-xs text-muted-foreground">Source: {p.emailSource}</div>}
        {/* A confirmed address needs no finder; it's one click away if it ever bounces. */}
        {(!p.email || !['verified', 'published'].includes(p.emailConfidence ?? '') || result) && <div className="flex gap-1.5">
          <Input value={d} onChange={(e) => setD(e.target.value)} placeholder="company.com" className="h-8 text-xs" />
          <Button
            size="sm"
            variant="secondary"
            className="h-8"
            disabled={!d || find.pending}
            onClick={async () => {
              const r = await find.run({ personId: p.id, domain: d })
              if (r) setResult(r)
            }}
          >
            <AtSign /> Find
          </Button>
        </div>}
        {pattern && <div className="text-xs text-muted-foreground">Known pattern: {pattern}</div>}
        {result && (
          <div className="space-y-1">
            {!result.mx && <div className="text-xs text-destructive">That domain has no mail server (MX record).</div>}
            {result.candidates.slice(0, 6).map((c) => (
              <div key={c.email} className="flex items-center gap-2 text-xs">
                <span className="min-w-0 flex-1 truncate font-mono">{c.email}</span>
                <span className="text-muted-foreground" title={c.source}>{c.confidence}</span>
                <Button size="sm" variant="ghost" className="h-6 px-2 text-xs" onClick={() => void save.run({ id: p.id, name: p.name, email: c.email, emailConfidence: c.confidence })}>
                  Use
                </Button>
              </div>
            ))}
            {result.evidence.patterns.length > 0 && (
              <div className="pt-1 text-[11px] text-muted-foreground">
                Public addresses at this domain: {result.evidence.patterns.map((x) => `${x.pattern} ×${x.count}`).join(', ')} (e.g. {result.evidence.addresses.slice(0, 3).map((a) => a.email).join(', ')})
              </div>
            )}
            {(p.bouncedEmails?.length ?? 0) > 0 && <div className="text-[11px] text-muted-foreground">Bounced before: {p.bouncedEmails!.join(', ')}</div>}
            <p className="pt-1 text-[11px] text-muted-foreground">Guesses aren’t verified. Add a Hunter.io key in Settings for verified lookups, or ask your AI to research a published address.</p>
          </div>
        )}
      </div>
    </Section>
  )
}
