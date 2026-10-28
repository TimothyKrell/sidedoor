import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Check, Copy, ExternalLink, Loader2, RefreshCw } from 'lucide-react'
import { useState } from 'react'
import { toast } from 'sonner'
import { Button } from '~/components/ui/button'
import { Switch } from '~/components/ui/switch'
import { qo, rpc } from '~/lib/api'
import { cn } from '~/lib/utils'

type Provider = Awaited<ReturnType<typeof rpc.aiStatus>>['providers'][number]

const BLURB: Record<string, string> = {
  claude: "Anthropic's Claude, through your own claude command. The strongest writer.",
  codex: "OpenAI's Codex CLI, on your ChatGPT plan.",
  grok: "xAI's Grok Build. Can search X, so it's best for finding people and hiring posts there.",
  opencode: 'OpenCode, with any model you have connected to it.',
}

export const providerState = (p: Provider) => (!p.installed ? 'install' : p.auth === 'signed-out' ? 'signin' : 'ready')

export function CopyCommand({ cmd }: { cmd: string }) {
  const [done, setDone] = useState(false)
  return (
    <div className="flex items-center gap-1 rounded-md border bg-muted/60 py-1 pr-1 pl-2.5">
      <code className="min-w-0 flex-1 truncate font-mono text-xs">{cmd}</code>
      <Button
        type="button"
        size="icon"
        variant="ghost"
        className="size-7"
        onClick={() => {
          void navigator.clipboard.writeText(cmd)
          setDone(true)
          setTimeout(() => setDone(false), 1500)
        }}
        aria-label="Copy command"
      >
        {done ? <Check className="size-3.5" /> : <Copy className="size-3.5" />}
      </Button>
    </div>
  )
}

/**
 * The AI CLIs on this computer: installed or not, signed in or not, which one Sidedoor uses, and
 * whether the user's own sessions can reach Sidedoor (its MCP server registered in that CLI).
 */
export function AiConnections({ compact = false }: { compact?: boolean }) {
  const qc = useQueryClient()
  const { data, isFetching } = useQuery(qo.aiStatus())
  const [busy, setBusy] = useState<string | null>(null)
  const recheck = async () => {
    const d = await rpc.aiStatus({ force: true })
    qc.setQueryData(qo.aiStatus().queryKey, d)
  }
  if (!data)
    return (
      <div className="flex items-center gap-2 py-6 text-sm text-muted-foreground">
        <Loader2 className="size-4 animate-spin" /> Looking for AI tools on this computer…
      </div>
    )
  const setDefault = async (id: Provider['id']) => {
    await rpc.setDefaultAi({ provider: id })
    void qc.invalidateQueries({ queryKey: ['aiStatus'] })
    void qc.invalidateQueries({ queryKey: ['settings'] })
  }
  const test = async (id: Provider['id']) => {
    setBusy(`test:${id}`)
    try {
      const r = await rpc.testAi({ provider: id })
      toast.success(`${data.providers.find((p) => p.id === id)?.name} answered in ${(r.ms / 1000).toFixed(1)}s`)
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(null)
    }
  }
  const connect = async (id: Provider['id'], on: boolean) => {
    setBusy(`connect:${id}`)
    try {
      await rpc.connectAi({ provider: id, connect: on })
      await recheck()
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(null)
    }
  }
  return (
    <div className="space-y-2">
      {data.providers.map((p) => {
        const st = providerState(p)
        const isDefault = data.default === p.id
        return (
          <div key={p.id} className={cn('rounded-xl border p-4 transition-colors', isDefault && 'border-primary/60 bg-primary/[0.03]')}>
            <div className="flex items-start gap-3">
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-medium">{p.name}</span>
                  {st === 'ready' ? (
                    <span className="inline-flex items-center gap-1 text-xs text-success">
                      <span className="size-1.5 rounded-full bg-success" /> Ready{p.version ? ` · ${p.version}` : ''}
                    </span>
                  ) : st === 'signin' ? (
                    <span className="text-xs text-hot">Installed, not signed in</span>
                  ) : (
                    <span className="text-xs text-muted-foreground">Not installed</span>
                  )}
                  {isDefault && <span className="rounded-md bg-primary/15 px-1.5 py-0.5 text-[11px] font-medium text-primary">Default</span>}
                </div>
                {!compact && <p className="mt-0.5 text-sm text-muted-foreground">{BLURB[p.id]}</p>}
                {p.account && st === 'ready' && <p className="mt-0.5 text-xs text-muted-foreground">{p.account}</p>}
              </div>
              {st === 'ready' && !isDefault && (
                <Button size="sm" variant="outline" onClick={() => void setDefault(p.id)}>
                  Use this
                </Button>
              )}
              {st === 'ready' && (
                <Button size="sm" variant="ghost" onClick={() => void test(p.id)} disabled={busy === `test:${p.id}`}>
                  {busy === `test:${p.id}` ? <Loader2 className="animate-spin" /> : 'Test'}
                </Button>
              )}
            </div>
            {st !== 'ready' && (
              <div className="mt-3 space-y-1.5">
                <p className="text-xs text-muted-foreground">{st === 'install' ? 'Install it in a terminal:' : 'Sign in from a terminal:'}</p>
                <CopyCommand cmd={st === 'install' ? p.install : p.login} />
                {st === 'install' && (
                  <a href={p.docsUrl} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground">
                    Setup guide <ExternalLink className="size-3" />
                  </a>
                )}
              </div>
            )}
            {st === 'ready' && (
              <label className="mt-3 flex items-center justify-between gap-3 border-t pt-3 text-sm">
                <span>
                  Add Sidedoor to {p.name}
                  {!compact && <span className="block text-xs text-muted-foreground">Adds a “sidedoor” entry to {p.name}’s settings, so any {p.name} session can see and update your search.</span>}
                </span>
                {busy === `connect:${p.id}` ? <Loader2 className="size-4 animate-spin" /> : <Switch checked={p.connected} onCheckedChange={(v) => void connect(p.id, v)} />}
              </label>
            )}
          </div>
        )
      })}
      <Button variant="ghost" size="sm" onClick={() => void recheck()} disabled={isFetching}>
        <RefreshCw className={cn(isFetching && 'animate-spin')} /> Check again
      </Button>
    </div>
  )
}
