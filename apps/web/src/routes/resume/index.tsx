import { useSuspenseQuery } from '@tanstack/react-query'
import { createFileRoute, Link, useNavigate } from '@tanstack/react-router'
import { Copy, FileDown, FilePlus2, FileText, MoreHorizontal, Trash2, Upload } from 'lucide-react'
import { useState } from 'react'
import { toast } from 'sonner'
import { Empty, Section, TimeAgo } from '~/components/app/bits'
import { ResumeImport } from '~/components/resume/import'
import { Button } from '~/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '~/components/ui/dialog'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '~/components/ui/dropdown-menu'
import { qo, rpc } from '~/lib/api'

export const Route = createFileRoute('/resume/')({
  loader: ({ context }) => context.queryClient.ensureQueryData(qo.resumes()),
  component: Resumes,
})

const fileUrl = (rel: string) => `/files/${rel.split('/').map(encodeURIComponent).join('/')}`

function Resumes() {
  const { data } = useSuspenseQuery(qo.resumes())
  const nav = useNavigate()
  const [importing, setImporting] = useState(false)
  const base = data.filter((r) => r.kind === 'base')
  const tailored = data.filter((r) => r.kind === 'tailored')
  const create = async (copyFrom?: string) => {
    const r = await rpc.createResume({ title: copyFrom ? 'Copy of resume' : base.length ? 'New resume' : 'Main resume', ...(copyFrom ? { copyFrom } : {}) })
    void nav({ to: '/resume/$id', params: { id: r.id } })
  }

  return (
    <div className="space-y-8">
      <div className="flex flex-wrap items-end gap-3">
        <div className="min-w-0 flex-1">
          <h1 className="text-2xl font-semibold tracking-tight">Resumes</h1>
          <p className="mt-0.5 text-sm text-muted-foreground">Your main resume, and the tailored copies your AI makes for each application.</p>
        </div>
        <Button variant="outline" onClick={() => setImporting(true)}>
          <Upload /> Import
        </Button>
        <Button onClick={() => void create()}>
          <FilePlus2 /> New resume
        </Button>
      </div>

      <Section title="Main">
        {base.length === 0 ? (
          <Empty>
            No resume yet. <button type="button" className="text-primary underline-offset-2 hover:underline" onClick={() => setImporting(true)}>Import the one you have</button> or start a new one.
          </Empty>
        ) : (
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {base.map((r) => (
              <ResumeCard key={r.id} r={r} onCopy={() => void create(r.id)} />
            ))}
          </div>
        )}
      </Section>

      {tailored.length > 0 && (
        <Section title="Tailored">
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {tailored.map((r) => (
              <ResumeCard key={r.id} r={r} onCopy={() => void create(r.id)} />
            ))}
          </div>
        </Section>
      )}

      <Dialog open={importing} onOpenChange={setImporting}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Import a resume</DialogTitle>
            <DialogDescription>Your AI turns it into an editable resume. It copies what's there and adds nothing.</DialogDescription>
          </DialogHeader>
          <ResumeImport
            onDone={(id) => {
              setImporting(false)
              toast.success('Imported. Check it over, then pick a design.')
              void nav({ to: '/resume/$id', params: { id } })
            }}
          />
        </DialogContent>
      </Dialog>
    </div>
  )
}

function ResumeCard({ r, onCopy }: { r: { id: string; title: string; kind: string; theme: string; pdfFile: string | null; pdfPages: number | null; updatedAt: string }; onCopy: () => void }) {
  return (
    <div className="group relative flex items-start gap-3 rounded-xl border bg-card p-4 transition-colors hover:border-foreground/25">
      <FileText className="mt-0.5 size-5 shrink-0 text-muted-foreground" />
      <Link to="/resume/$id" params={{ id: r.id }} className="min-w-0 flex-1 after:absolute after:inset-0">
        <div className="truncate font-medium">{r.title}</div>
        <div className="mt-0.5 text-xs text-muted-foreground">
          <span className="capitalize">{r.theme}</span>
          {r.pdfPages ? ` · ${r.pdfPages} page${r.pdfPages === 1 ? '' : 's'}` : ''} · <TimeAgo iso={r.updatedAt} />
        </div>
      </Link>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="ghost" size="icon" className="relative z-10 -my-1 size-8" aria-label="More">
            <MoreHorizontal />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          {r.pdfFile && (
            <DropdownMenuItem onSelect={() => window.open(fileUrl(r.pdfFile!), '_blank')}>
              <FileDown /> Open PDF
            </DropdownMenuItem>
          )}
          <DropdownMenuItem onSelect={onCopy}>
            <Copy /> Duplicate
          </DropdownMenuItem>
          <DropdownMenuItem
            className="text-destructive"
            onSelect={() => confirm(`Delete “${r.title}”? Its history goes too.`) && void rpc.deleteResume({ id: r.id }).then(() => toast.success('Deleted'))}
          >
            <Trash2 /> Delete
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  )
}
