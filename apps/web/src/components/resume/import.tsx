import { useQuery } from '@tanstack/react-query'
import { FileUp, Loader2 } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { Button } from '~/components/ui/button'
import { Textarea } from '~/components/ui/textarea'
import { qo, rpc } from '~/lib/api'
import { cn } from '~/lib/utils'

/**
 * Bring in an existing resume: drop a PDF or Word file (or paste text). The server extracts the
 * text, and the user's AI rebuilds it as a structured resume and seeds the Experience document.
 */
export function ResumeImport({ onDone, resumeId, theme, compact = false }: { onDone: (resumeId: string) => void; resumeId?: string; theme?: string; compact?: boolean }) {
  const input = useRef<HTMLInputElement>(null)
  const [drag, setDrag] = useState(false)
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [paste, setPaste] = useState(false)
  const [text, setText] = useState('')
  const [taskId, setTaskId] = useState<string | null>(null)
  const task = useQuery({ ...qo.task(taskId ?? ''), enabled: !!taskId })

  useEffect(() => {
    const t = task.data
    if (!t) return
    if (t.status === 'done') {
      setTaskId(null)
      setBusy(null)
      try {
        onDone((JSON.parse(t.output ?? '{}') as { resumeId: string }).resumeId)
      } catch {
        setError('Imported, but the result was unreadable. Open the Resume page.')
      }
    } else if (t.status === 'failed' || t.status === 'cancelled') {
      setTaskId(null)
      setBusy(null)
      setError(t.error ?? 'The import failed.')
    }
  }, [task.data, onDone])

  const start = async (body: string) => {
    setBusy('Your AI is reading your resume. This takes a minute or two…')
    const r = await rpc.importResume({ text: body, ...(resumeId ? { resumeId } : {}), ...(theme ? { theme } : {}) })
    setTaskId(r.taskId)
  }

  const upload = async (f: File) => {
    setError(null)
    setBusy(`Reading ${f.name}…`)
    try {
      const res = await fetch('/api/upload/resume', { method: 'POST', headers: { 'x-filename': f.name }, body: f })
      const j = (await res.json()) as { text?: string; error?: string }
      if (!res.ok || !j.text) throw new Error(j.error ?? 'Could not read that file')
      await start(j.text)
    } catch (e) {
      setBusy(null)
      setError(e instanceof Error ? e.message : String(e))
    }
  }

  if (busy)
    return (
      <div className="flex items-center gap-3 rounded-xl border border-dashed p-6 text-sm text-muted-foreground">
        <Loader2 className="size-5 animate-spin" /> {busy}
      </div>
    )

  return (
    <div className="space-y-3">
      {!paste ? (
        <button
          type="button"
          onClick={() => input.current?.click()}
          onDragOver={(e) => {
            e.preventDefault()
            setDrag(true)
          }}
          onDragLeave={() => setDrag(false)}
          onDrop={(e) => {
            e.preventDefault()
            setDrag(false)
            const f = e.dataTransfer.files[0]
            if (f) void upload(f)
          }}
          className={cn('flex w-full flex-col items-center justify-center gap-2 rounded-xl border border-dashed text-center transition-colors hover:border-foreground/40 hover:bg-muted/40', compact ? 'p-5' : 'p-8', drag && 'border-primary bg-primary/5')}
        >
          <FileUp className="size-6 text-muted-foreground" />
          <span className="text-sm font-medium">Drop your resume here, or click to choose</span>
          <span className="text-xs text-muted-foreground">PDF, Word (.docx), or text</span>
        </button>
      ) : (
        <div className="space-y-2">
          <Textarea value={text} onChange={(e) => setText(e.target.value)} placeholder="Paste your resume text" className="min-h-48 text-sm" />
          <Button size="sm" disabled={text.trim().length < 80} onClick={() => void start(text)}>
            Import
          </Button>
        </div>
      )}
      <input ref={input} type="file" accept=".pdf,.docx,.txt,.md,.html" hidden onChange={(e) => e.target.files?.[0] && void upload(e.target.files[0])} />
      <button type="button" className="text-xs text-muted-foreground underline-offset-2 hover:underline" onClick={() => setPaste(!paste)}>
        {paste ? 'Upload a file instead' : 'Paste text instead'}
      </button>
      {error && <p className="text-sm text-destructive">{error}</p>}
    </div>
  )
}
