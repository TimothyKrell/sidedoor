import { Link } from '@tanstack/react-router'
import { AlertTriangle, ExternalLink as ExternalIcon, Loader2, Mail, MailX, MessageSquareText, Pencil, Send, Star, Trash2, Undo2, WandSparkles, X } from 'lucide-react'
import { useState } from 'react'
import { toast } from 'sonner'
import { Button } from '~/components/ui/button'
import { Input } from '~/components/ui/input'
import { Textarea } from '~/components/ui/textarea'
import { discardDraftFn, draftSentFn, emailBouncedFn, editDraftFn, saveDraftFn, setPostingStatusFn, trackPostingFn } from '~/lib/api'
import { PERSON_KIND_LABEL, RELATIONSHIP_LABEL, salaryRange } from '@sidedoor/shared/format'
import { xHandle } from '@sidedoor/shared/x'
import { useAction } from '~/lib/use-action'
import { cn } from '~/lib/utils'
import { CompanyAvatar, CopyButton, Due, FitBadge, Freshness, LocationFlag, Salary, StageBadge, TimeAgo } from './bits'
import { type EditorChange, useTellReport, WritingReview } from './writing'

export interface PostingLike {
  id: string
  companyName: string | null
  title: string
  location: string | null
  postedAt: string | null
  firstSeenAt: string
  compText: string | null
  compMin?: number | null
  compMax?: number | null
  fitScore: number | null
  decision: string | null
  summary: string | null
  locationFit: string | null
  locationNote: string | null
  url: string | null
  applyUrl: string | null
  userStatus: string
  applicationId: string | null
}

export function PostingCard({ p, compact }: { p: PostingLike; compact?: boolean }) {
  const track = useAction((d: { id: string }) => trackPostingFn({ data: d }), { success: 'Tracking it. Your AI is preparing the package and finding people.' })
  const status = useAction((d: { id: string; status: 'new' | 'starred' | 'dismissed' }) => setPostingStatusFn({ data: d }))
  return (
    <div className={cn('group rounded-xl border bg-card p-3.5 transition-colors hover:border-primary/40', p.userStatus === 'dismissed' && 'opacity-60')}>
      <div className="flex gap-3">
        <CompanyAvatar name={p.companyName} />
        <div className="min-w-0 flex-1">
          <div className="flex items-start gap-2">
            <Link to="/jobs/$id" params={{ id: p.id }} className="min-w-0 flex-1">
              <div className="line-clamp-2 text-base font-medium leading-tight">{p.title}</div>
              <div className="mt-0.5 truncate text-xs text-muted-foreground">
                {[p.companyName, p.location?.replace(/\s*\|\s*/g, ' · ')].filter((x) => x && !/^unknown$/i.test(x)).join(' · ') || 'Company not listed'}
              </div>
            </Link>
            <div className="flex shrink-0 flex-col items-end gap-1">
              <FitBadge fit={p.fitScore} />
              <Freshness postedAt={p.postedAt} firstSeenAt={p.firstSeenAt} />
            </div>
          </div>
          {!compact && p.summary && <p className="mt-2 line-clamp-2 text-[13px] text-muted-foreground">{p.summary}</p>}
          <div className="mt-2.5 flex flex-wrap items-center gap-1.5">
            <Salary text={p.compText} min={p.compMin} max={p.compMax} className="mr-1" />
            <LocationFlag fit={p.locationFit} note={p.locationNote} />
            {p.applicationId ? (
              <Button asChild size="sm" variant="secondary" className="h-7">
                <Link to="/applications/$id" params={{ id: p.applicationId }}>
                  Open application
                </Link>
              </Button>
            ) : (
              <Button size="sm" variant="outline" className="h-7" disabled={track.pending} onClick={() => void track.run({ id: p.id })}>
                Go after it
              </Button>
            )}
            {(p.applyUrl ?? p.url) && (
              <Button asChild size="sm" variant="ghost" className="h-7 text-muted-foreground max-sm:px-2">
                <a href={(p.applyUrl ?? p.url)!} target="_blank" rel="noreferrer" aria-label="Open the posting">
                  <span className="max-sm:hidden">Posting</span> <ExternalIcon />
                </a>
              </Button>
            )}
            <div className="ml-auto flex gap-0.5">
              <Button size="icon" variant="ghost" className={cn('size-7', p.userStatus === 'starred' && 'text-primary')} onClick={() => void status.run({ id: p.id, status: p.userStatus === 'starred' ? 'new' : 'starred' })} aria-label="Star">
                <Star className={cn(p.userStatus === 'starred' && 'fill-current')} />
              </Button>
              {!p.applicationId && (
                <Button size="icon" variant="ghost" className="size-7" onClick={() => void status.run({ id: p.id, status: p.userStatus === 'dismissed' ? 'new' : 'dismissed' })} aria-label="Dismiss">
                  <X />
                </Button>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}

export interface AppLike {
  id: string
  companyName: string
  role: string
  stage: string
  fitScore: number | null
  nextAction: string | null
  nextActionDate: string | null
  priority?: string
  compText?: string | null
  compMin?: number | null
  compMax?: number | null
  listing?: { postedAt: string | null; firstSeenAt: string; compText: string | null; compMin: number | null; compMax: number | null } | null
  /** AI prep under way for it (queued or running). */
  prep?: { revision: boolean; running: boolean } | null
}

/** What the AI is doing with an application, in a word or two. */
export const prepLabel = (p: { revision: boolean; running: boolean }) => (!p.running ? 'Waiting for your AI' : p.revision ? 'Your AI is revising it' : 'Your AI is preparing it')

/** showListing adds the salary range and the posting's age (the pipeline board). */
export function AppRow({ a, showStage = true, showListing = false }: { a: AppLike; showStage?: boolean; showListing?: boolean }) {
  // The application's own comp text is often the agent's note ("Not published"); fall back to the board's figures.
  const comp = salaryRange(a.compText, a.compMin, a.compMax) ? { text: a.compText, min: a.compMin, max: a.compMax } : { text: a.listing?.compText, min: a.listing?.compMin, max: a.listing?.compMax }
  const hasListing = showListing && (a.listing || salaryRange(comp.text, comp.min, comp.max))
  return (
    <Link to="/applications/$id" params={{ id: a.id }} className="flex items-start gap-3 rounded-xl border bg-card px-3 py-2.5 transition-colors hover:border-primary/40">
      <CompanyAvatar name={a.companyName} className="size-8 text-xs" />
      <div className="min-w-0 flex-1">
        {/* Company and role on their own lines: one company's roles often differ only at the end. */}
        <div className="truncate text-sm font-medium">{a.companyName}</div>
        <div className="line-clamp-2 text-sm text-muted-foreground">{a.role}</div>
        {a.prep ? (
          <div className="mt-0.5 flex items-center gap-1.5 text-xs text-info">
            <Loader2 className={cn('size-3 shrink-0', a.prep.running && 'animate-spin')} />
            {prepLabel(a.prep)}
          </div>
        ) : (
          a.nextAction && <div className="mt-0.5 truncate text-xs text-muted-foreground">{a.nextAction}</div>
        )}
        {/* One wrapping meta row, so dates never sit on top of each other in narrow columns. */}
        {(hasListing || a.nextActionDate) && (
          <div className="mt-1 flex flex-wrap items-center gap-x-2.5 gap-y-0.5 text-xs">
            <Due date={a.nextActionDate} />
            {hasListing && <Salary {...comp} />}
            {hasListing && a.listing && <Freshness postedAt={a.listing.postedAt} firstSeenAt={a.listing.firstSeenAt} />}
          </div>
        )}
      </div>
      <div className="shrink-0 self-start">{showStage ? <StageBadge stage={a.stage} /> : <FitBadge fit={a.fitScore} />}</div>
    </Link>
  )
}

export interface PersonLike {
  id: string
  name: string
  title: string | null
  companyName: string | null
  kind: string
  stage: string
  email: string | null
  nextContactAt: string | null
  nextAction: string | null
  lastContactAt: string | null
}

export function PersonRow({ p, extra }: { p: PersonLike; extra?: React.ReactNode }) {
  return (
    <Link to="/people/$id" params={{ id: p.id }} className="flex items-center gap-3 rounded-xl border bg-card px-3 py-2.5 transition-colors hover:border-primary/40">
      <span className="flex size-8 shrink-0 items-center justify-center rounded-full bg-secondary text-xs font-semibold">
        {p.name
          .split(/\s+/)
          .map((x) => x[0])
          .slice(0, 2)
          .join('')}
      </span>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-1.5 truncate text-sm font-medium">
          {p.name}
          {p.email && <Mail className="size-3 text-muted-foreground" />}
        </div>
        <div className="truncate text-xs text-muted-foreground">
          {/* The kind is left out when the title already says it ("Recruiter · Recruiter"). */}
          {[p.title && p.title.toLowerCase().includes((PERSON_KIND_LABEL[p.kind] ?? p.kind).toLowerCase()) ? null : (PERSON_KIND_LABEL[p.kind] ?? p.kind), p.title, p.companyName].filter(Boolean).join(' · ')}
        </div>
        {p.nextAction && <div className="truncate text-xs text-muted-foreground/80">→ {p.nextAction}</div>}
      </div>
      <div className="flex shrink-0 flex-col items-end gap-1 text-xs">
        <span className="text-muted-foreground">{RELATIONSHIP_LABEL[p.stage] ?? p.stage}</span>
        {p.nextContactAt ? <Due date={p.nextContactAt} /> : p.lastContactAt ? <TimeAgo iso={p.lastContactAt} className="text-muted-foreground" /> : null}
        {extra}
      </div>
    </Link>
  )
}

export interface DraftLike {
  id: string
  channel: string
  toEmail: string | null
  subject: string | null
  body: string
  status: string
  author: string
  createdAt: string
  composeUrl: string
  /** Profile, or a people search when we don't have their profile URL. */
  linkedinUrl?: string | null
  /** Their X profile (https://x.com/<handle>), when we have it. */
  xUrl?: string | null
  personId: string | null
  personName?: string | null
  /** The agent's draft before the editor pass (body is the edited version). */
  originalBody?: string | null
  editorChanges?: EditorChange[] | null
  /** Set when the address may not arrive (a guess, or not the one on file). */
  emailNote?: { confidence: string; source: string } | null
  editedAt?: string | null
  editorError?: string | null
}

/** `people`: who this draft could go to; enables changing the recipient while editing. */
export function DraftCard({ d, personName, people }: { d: DraftLike; personName?: string | null; people?: { id: string; name: string }[] }) {
  const [editing, setEditing] = useState(false)
  const [recipient, setRecipient] = useState(d.personId ?? '')
  const [subject, setSubject] = useState(d.subject ?? '')
  const [body, setBody] = useState(d.body)
  const [to, setTo] = useState(d.toEmail ?? '')
  const save = useAction((v: { id: string; subject: string; body: string; toEmail: string; personId?: string | null }) => saveDraftFn({ data: v }), { success: 'Saved' })
  const sent = useAction((v: { id: string }) => draftSentFn({ data: v }), { success: 'Logged as sent. Follow-up scheduled.' })
  const discard = useAction((v: { id: string }) => discardDraftFn({ data: v }))
  const editor = useAction((v: { id: string }) => editDraftFn({ data: v }), { success: (r) => (r.edited ? 'Editor pass done' : 'Editor found nothing to change') })
  const bounced = useAction((v: { personId: string; email: string | null }) => emailBouncedFn({ data: v }), {
    success: (r) => (r.current ? `Noted. Their address on file is now ${r.current}.` : r.next ? `Next try: ${r.next.email} (${r.next.confidence}). A copy of the email is back in drafts.` : 'Marked as bounced. No other address found; try LinkedIn.'),
  })
  const useOriginal = useAction((v: { id: string; body: string }) => saveDraftFn({ data: v }), { success: 'Switched to the original' })
  const editingTells = useTellReport(editing ? body : null)
  const name = personName ?? d.personName
  const isEmail = d.channel === 'email'
  return (
    <div className={cn('rounded-xl border bg-card p-3.5', d.status === 'sent' && 'opacity-70')}>
      <div className="mb-2 flex items-center gap-2 text-xs text-muted-foreground">
        {isEmail ? <Mail className="size-3.5" /> : <MessageSquareText className="size-3.5" />}
        <span className="truncate">
          {d.channel} {name ? <>to <span className="text-foreground">{name}</span></> : null} {d.toEmail || to ? `<${to || d.toEmail}>` : isEmail ? '(no email yet)' : d.channel === 'x' && d.xUrl ? `@${xHandle(d.xUrl)}` : ''}
        </span>
        <span className="ml-auto shrink-0">{d.status === 'sent' ? 'sent' : d.author === 'agent' ? 'AI draft' : 'your draft'}</span>
      </div>
      {editing ? (
        <div className="space-y-2">
          {people && people.length > 0 && (
            <label className="flex items-center gap-2 text-xs text-muted-foreground">
              To
              <select value={recipient} onChange={(e) => setRecipient(e.target.value)} className="h-8 flex-1 rounded-md border bg-background px-2 text-sm text-foreground">
                {!recipient && <option value="">Choose a person</option>}
                {people.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
              </select>
            </label>
          )}
          {isEmail && <Input value={to} onChange={(e) => setTo(e.target.value)} placeholder="to@company.com" className="h-8 text-sm" />}
          {isEmail && <Input value={subject} onChange={(e) => setSubject(e.target.value)} placeholder="Subject" className="h-8 text-sm" />}
          <Textarea value={body} onChange={(e) => setBody(e.target.value)} rows={9} className="text-sm" />
          {editingTells && (
            <div className="text-xs text-muted-foreground">
              AI tells {editingTells.score}
              {editingTells.hits.filter((h) => h.weight >= 1).length > 0 && `: ${editingTells.hits.filter((h) => h.weight >= 1).map((h) => `“${h.match}”`).join(', ')}`}
            </div>
          )}
          <div className="flex gap-2">
            <Button size="sm" onClick={async () => { await save.run({ id: d.id, subject, body, toEmail: to, ...(people && recipient !== (d.personId ?? '') ? { personId: recipient || null } : {}) }); setEditing(false) }}>
              Save
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setEditing(false)}>
              Cancel
            </Button>
          </div>
        </div>
      ) : (
        <>
          {d.subject && <div className="mb-1 text-sm font-medium">{d.subject}</div>}
          <WritingReview
            current={d.body}
            original={d.originalBody}
            changes={d.editorChanges}
            actions={(view) =>
              view === 'original' && d.status === 'draft' && d.originalBody ? (
                <Button size="sm" variant="ghost" className="h-7 text-xs" disabled={useOriginal.pending} onClick={() => void useOriginal.run({ id: d.id, body: d.originalBody! })}>
                  <Undo2 /> Use original
                </Button>
              ) : null
            }
          />
          {d.editorError && <div className="mt-1 text-xs text-destructive">Editor pass failed: {d.editorError}</div>}
        </>
      )}
      {d.status === 'draft' && !editing && isEmail && d.emailNote && (d.toEmail || to) && (
        <div className="mt-3 flex gap-2 rounded-lg border border-hot/30 bg-hot/10 px-2.5 py-2 text-xs">
          <AlertTriangle className="mt-px size-3.5 shrink-0 text-hot" />
          <div>
            <span className="font-medium text-foreground">{d.emailNote.confidence === 'unknown' ? 'Unconfirmed address.' : `This address is a ${d.emailNote.confidence === 'pattern' ? 'pattern match' : 'guess'}, not verified.`}</span>{' '}
            <span className="text-muted-foreground">
              {d.emailNote.source && `Based on: ${d.emailNote.source}. `}It may bounce{d.linkedinUrl ? '; LinkedIn is the surer route' : ''}. If it does, press “It bounced” and Sidedoor tries the next most likely address.
            </span>
          </div>
        </div>
      )}
      {d.status === 'sent' && isEmail && d.personId && (
        <div className="mt-2 flex justify-end">
          <Button size="sm" variant="ghost" className="h-7 text-xs text-muted-foreground" disabled={bounced.pending} onClick={() => void bounced.run({ personId: d.personId!, email: d.toEmail })} title="Got a delivery failure? Marks this address bad and finds the next most likely one">
            {bounced.pending ? <Loader2 className="animate-spin" /> : <MailX />} It bounced
          </Button>
        </div>
      )}
      {d.status === 'draft' && !editing && (
        <div className="mt-3 flex flex-wrap gap-1.5">
          {isEmail ? (
            <Button asChild size="sm" variant={d.emailNote ? 'outline' : 'default'} className="h-8" title={d.emailNote ? 'This address is a guess and may bounce' : undefined}>
              <a href={d.composeUrl} target="_blank" rel="noreferrer">
                <Send /> Open in Gmail
              </a>
            </Button>
          ) : d.channel === 'linkedin' && d.linkedinUrl ? (
            <Button asChild size="sm" className="h-8">
              {/* Copies the message too, so it's ready to paste into the LinkedIn message box. */}
              <a href={d.linkedinUrl} target="_blank" rel="noreferrer" onClick={() => void navigator.clipboard?.writeText(d.body).then(() => toast.success('Message copied. Paste it into LinkedIn.'))}>
                <ExternalIcon /> {d.linkedinUrl.includes('/search/') ? 'Find on LinkedIn' : 'Open LinkedIn'}
              </a>
            </Button>
          ) : d.channel === 'x' && d.xUrl ? (
            <Button asChild size="sm" className="h-8">
              {/* X's DM compose link needs their numeric user id, so open the profile and copy the message for the Message button. */}
              <a href={d.xUrl} target="_blank" rel="noreferrer" onClick={() => void navigator.clipboard?.writeText(d.body).then(() => toast.success('Message copied. Paste it into an X DM.'))}>
                <ExternalIcon /> Open X
              </a>
            </Button>
          ) : (
            <CopyButton text={d.body} label="Copy message" className="h-8" />
          )}
          {((d.channel === 'linkedin' && d.linkedinUrl) || (d.channel === 'x' && d.xUrl)) && <CopyButton text={d.body} label="Copy message" className="h-8" />}
          {isEmail && <CopyButton text={`${d.subject ? `${d.subject}\n\n` : ''}${d.body}`} className="h-8" />}
          <Button size="sm" variant="outline" className="h-8" disabled={sent.pending} onClick={() => void sent.run({ id: d.id })}>
            I sent it
          </Button>
          {!d.editedAt && (
            <Button size="sm" variant="ghost" className="h-8" disabled={editor.pending} onClick={() => void editor.run({ id: d.id })} title="Second AI pass against your writing style">
              {editor.pending ? <Loader2 className="animate-spin" /> : <WandSparkles />} Editor pass
            </Button>
          )}
          <Button size="icon" variant="ghost" className="size-8" onClick={() => setEditing(true)} aria-label="Edit">
            <Pencil />
          </Button>
          <Button size="icon" variant="ghost" className="size-8" onClick={() => void discard.run({ id: d.id })} aria-label="Discard">
            <Trash2 />
          </Button>
        </div>
      )}
    </div>
  )
}
