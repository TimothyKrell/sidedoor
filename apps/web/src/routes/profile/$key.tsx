import { useQueryClient, useSuspenseQuery } from '@tanstack/react-query'
import { createFileRoute, Link, notFound } from '@tanstack/react-router'
import { ArrowLeft, Bot, Loader2, RotateCcw } from 'lucide-react'
import { renderMarkdown } from '~/lib/markdown'
import { useEffect, useState } from 'react'
import { toast } from 'sonner'
import { useChat } from '~/components/app/chat'
import { Segmented } from '~/components/app/segmented'
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
        {!data.isDefault && data.template && (
          <Button variant="ghost" size="sm" className="text-muted-foreground" onClick={() => confirm('Replace this with the starting template? Your text will be lost.') && setBody(data.template)}>
            <RotateCcw /> Start from the template
          </Button>
        )}
      </div>
    </div>
  )
}
