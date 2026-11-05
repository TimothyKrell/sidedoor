import { useQuery, useQueryClient, useSuspenseQuery } from '@tanstack/react-query'
import { createFileRoute, Link, notFound } from '@tanstack/react-router'
import { ArrowLeft, Bot, ChevronRight, History, Loader2, RotateCcw, Undo2 } from 'lucide-react'
import { renderMarkdown } from '~/lib/markdown'
import { useEffect, useState } from 'react'
import { toast } from 'sonner'
import { Empty, Section, TimeAgo } from '~/components/app/bits'
import { useChat } from '~/components/app/chat'
import { Segmented } from '~/components/app/segmented'
import { Badge } from '~/components/ui/badge'
import { Button } from '~/components/ui/button'
import { Textarea } from '~/components/ui/textarea'
import { qo, rpc } from '~/lib/api'

const KEYS = ['experience', 'search', 'answers', 'writing', 'tells'] as const
type Key = (typeof KEYS)[number]

export const Route = createFileRoute('/profile/$key')({
  loader: ({ context, params }) => {
    if (!KEYS.includes(params.key as Key)) throw notFound()
    return context.queryClient.ensureQueryData(qo.doc(params.key as Key))
  },
  component: DocPage,
})

/** Documents unsent drafts are checked against when they change (server: services/stale-flags.ts). */
const CHECKED = ['experience', 'answers'] as const

const ASK: Partial<Record<Key, string>> = {
  experience: 'Interview me to fill out my Experience document: go role by role, ask what I built and the numbers behind it, and add what I confirm.',
  search: 'Help me write down what I want in my next job. Ask me questions one at a time, then update my "What I want" document.',
  answers: 'Help me fill in my standard application answers. Ask me each one, then save them.',
  writing: 'Read a few of my sent messages and help me describe my writing voice in my Writing style document.',
}

function DocPage() {
  const { key } = Route.useParams() as { key: Key }
  const { data } = useSuspenseQuery(qo.doc(key))
  const qc = useQueryClient()
  const chat = useChat()
  const [body, setBody] = useState(data.body)
  const [view, setView] = useState<'edit' | 'preview'>('edit')
  const [saving, setSaving] = useState(false)
  useEffect(() => setBody(data.body), [data.body])
  const dirty = body !== data.body
  const save = async () => {
    setSaving(true)
    try {
      if (key === 'tells') JSON.parse(body)
      await rpc.saveDoc({ key, body })
      await qc.invalidateQueries({ queryKey: ['doc', key] })
      await qc.invalidateQueries({ queryKey: ['docs'] })
      toast.success('Saved')
    } catch (e) {
      toast.error(e instanceof SyntaxError ? `That isn't valid JSON: ${e.message}` : e instanceof Error ? e.message : String(e))
    } finally {
      setSaving(false)
    }
  }
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <Button asChild variant="ghost" size="icon" aria-label="Profile">
          <Link to="/profile">
            <ArrowLeft />
          </Link>
        </Button>
        <div className="min-w-0 flex-1">
          <h1 className="text-xl font-semibold tracking-tight">{data.title}</h1>
          <p className="text-sm text-muted-foreground">{data.hint}</p>
        </div>
        {ASK[key] && (
          <Button variant="outline" size="sm" onClick={() => chat.openChat({ send: ASK[key]!, newThread: true })}>
            <Bot /> Fill it in with your AI
          </Button>
        )}
        {key !== 'tells' && <Segmented value={view} onChange={setView} options={[{ value: 'edit', label: 'Edit' }, { value: 'preview', label: 'Preview' }]} />}
      </div>
      {view === 'edit' || key === 'tells' ? (
        <Textarea value={body} onChange={(e) => setBody(e.target.value)} className={`min-h-[60vh] text-sm leading-relaxed ${key === 'tells' ? 'font-mono text-xs' : ''}`} spellCheck={key !== 'tells'} />
      ) : (
        <div className="prose-sd min-h-[60vh] rounded-xl border p-5" dangerouslySetInnerHTML={{ __html: renderMarkdown(body) }} />
      )}
      <div className="flex items-center gap-2">
        <Button onClick={() => void save()} disabled={!dirty || saving}>
          {saving && <Loader2 className="animate-spin" />} Save
        </Button>
        {dirty && (
          <Button variant="ghost" onClick={() => setBody(data.body)}>
            Discard changes
          </Button>
        )}
        <div className="flex-1" />
        {(CHECKED as readonly Key[]).includes(key) && (
          <Button
            variant="ghost"
            size="sm"
            className="text-muted-foreground"
            title="Saving already does this; this checks again now"
            onClick={() =>
              void rpc
                .checkStaleDrafts({ docKey: key as (typeof CHECKED)[number] })
                .then(() => toast.success('Checking your unsent drafts against it. Anything out of date shows on the draft.'))
                .catch((e: unknown) => toast.error(e instanceof Error ? e.message : String(e)))
            }
          >
            <History /> Check unsent drafts
          </Button>
        )}
        {!data.isDefault && data.template && (
          <Button variant="ghost" size="sm" className="text-muted-foreground" onClick={() => confirm('Replace this with the starting template? Your text will be lost.') && setBody(data.template)}>
            <RotateCcw /> Start from the template
          </Button>
        )}
      </div>
      <Revisions docKey={key} dirty={dirty} />
    </div>
  )
}

const BY: Record<string, string> = { user: 'You', agent: 'Your AI', app: 'Sidedoor' }

/** Every change to the document (yours, an agent's, Sidedoor's), with what it removed and added, and a way back. */
function Revisions({ docKey, dirty }: { docKey: Key; dirty: boolean }) {
  const { data } = useQuery(qo.docRevisions(docKey))
  const qc = useQueryClient()
  const [open, setOpen] = useState<string | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  if (!data) return null
  const revert = async (id: string, index: number) => {
    const later = index > 0 ? ` This also undoes the ${index} newer change${index === 1 ? '' : 's'} above it.` : ''
    if (!confirm(`Put the document back to how it was before this change?${later}${dirty ? ' Your unsaved edits will be lost.' : ''}`)) return
    setBusy(id)
    try {
      await rpc.revertDocRevision({ id })
      await qc.invalidateQueries({ queryKey: ['doc', docKey] })
      await qc.invalidateQueries({ queryKey: ['docs'] })
      toast.success('Reverted')
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(null)
    }
  }
  return (
    <Section
      title={
        <span className="flex items-center gap-1.5">
          <History className="size-4" /> History
        </span>
      }
      count={data.length}
    >
      {data.length === 0 ? (
        <Empty>No changes yet. Every save and every edit your AI makes shows up here, and can be undone.</Empty>
      ) : (
        <ul className="divide-y rounded-xl border">
          {data.map((r, i) => {
            const delta = r.chars.after - r.chars.before
            return (
              <li key={r.id} className="px-3 py-2 text-sm">
                <div className="flex items-center gap-2">
                  <button type="button" className="flex min-w-0 flex-1 items-center gap-2 text-left" onClick={() => setOpen(open === r.id ? null : r.id)}>
                    <ChevronRight className={`size-4 shrink-0 text-muted-foreground transition-transform ${open === r.id ? 'rotate-90' : ''}`} />
                    <Badge variant={r.by === 'agent' ? 'default' : 'secondary'}>{BY[r.by] ?? r.by}</Badge>
                    <span className="min-w-0 flex-1 truncate">{r.reason ?? 'changed it'}</span>
                    <span className={`shrink-0 tabular-nums text-xs ${delta < 0 ? 'text-destructive' : 'text-muted-foreground'}`}>
                      {delta >= 0 ? '+' : ''}
                      {delta}
                    </span>
                    <TimeAgo iso={r.at} className="shrink-0 text-xs text-muted-foreground" />
                  </button>
                  <Button variant="ghost" size="sm" disabled={busy != null} onClick={() => void revert(r.id, i)}>
                    {busy === r.id ? <Loader2 className="animate-spin" /> : <Undo2 />} Revert
                  </Button>
                </div>
                {open === r.id && (
                  <div className="mt-2 space-y-2">
                    {r.change.removed && <pre className="whitespace-pre-wrap rounded-lg bg-destructive/10 p-2 text-xs line-through decoration-destructive/40">{r.change.removed}</pre>}
                    {r.change.added && <pre className="whitespace-pre-wrap rounded-lg bg-emerald-500/10 p-2 text-xs">{r.change.added}</pre>}
                    {!r.change.removed && !r.change.added && <p className="text-xs text-muted-foreground">No text changed.</p>}
                  </div>
                )}
              </li>
            )
          })}
        </ul>
      )}
    </Section>
  )
}
