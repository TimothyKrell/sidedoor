import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Check, Copy, Loader2 } from 'lucide-react'
import { type ReactNode, useEffect, useState } from 'react'
import { toast } from 'sonner'
import { timeAgo } from '@sidedoor/shared/format'
import { CopyCommand } from '~/components/app/ai-connect'
import { Button } from '~/components/ui/button'
import { Input } from '~/components/ui/input'
import { Switch } from '~/components/ui/switch'
import { qo, rpc } from '~/lib/api'

const Step = ({ n, title, children }: { n: number; title: string; children: ReactNode }) => (
  <div className="space-y-2">
    <div className="text-sm font-medium">
      {n}. {title}
    </div>
    <div className="space-y-2 pl-4 text-sm">{children}</div>
  </div>
)

const Hint = ({ children }: { children: ReactNode }) => <p className="text-xs text-muted-foreground">{children}</p>

/**
 * xAI's Grok Bot: its Bots run on a cloud computer, so they reach Sidedoor at a public address with
 * their own token, and take the research sent to them from Sidedoor's queue. A routine webhook
 * wakes the Bot when something is waiting.
 */
export function GrokBotCard() {
  const qc = useQueryClient()
  const { data } = useQuery(qo.grokBot())
  const [publicUrl, setPublicUrl] = useState('')
  const [webhookUrl, setWebhookUrl] = useState('')
  const [key, setKey] = useState('')
  const [busy, setBusy] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)
  useEffect(() => {
    if (!data) return
    setPublicUrl(data.settings.publicUrl)
    setWebhookUrl(data.settings.webhookUrl)
  }, [data?.settings.publicUrl, data?.settings.webhookUrl])
  if (!data) return null

  const run = async (what: string, fn: () => Promise<unknown>, done?: string) => {
    setBusy(what)
    try {
      await fn()
      await qc.invalidateQueries({ queryKey: ['grokBot'] })
      if (done) toast.success(done)
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(null)
    }
  }
  const spin = (what: string) => busy === what && <Loader2 className="animate-spin" />

  if (!data.on)
    return (
      <div className="flex items-center justify-between gap-3">
        <Hint>Give Grok Bot its own key to Sidedoor, so your Bots can work on your search and take the research you send them.</Hint>
        <Button size="sm" disabled={!!busy} onClick={() => void run('on', () => rpc.setGrokBot({ on: true }))}>
          {spin('on')} Turn on
        </Button>
      </div>
    )

  const status = [
    data.waiting ? `${data.waiting} waiting` : null,
    data.working ? `${data.working} in progress` : null,
    data.finishedAt ? `last finished a task ${timeAgo(data.finishedAt)}` : data.tookAt ? `last took a task ${timeAgo(data.tookAt)}` : 'hasn’t taken a task yet',
  ].filter(Boolean)

  return (
    <div className="space-y-5">
      <Step n={1} title="Let Grok Bot reach Sidedoor">
        <Hint>
          Grok Bot runs on a cloud computer, so it needs a public address. Tailscale Funnel publishes Sidedoor’s agent endpoint (/mcp) and nothing else; every request needs Grok Bot’s token.
        </Hint>
        <CopyCommand cmd={data.funnel} />
        <div className="flex gap-2">
          <Input value={publicUrl} onChange={(e) => setPublicUrl(e.target.value)} placeholder="https://your-machine.your-tailnet.ts.net" />
          <Button variant="outline" disabled={publicUrl === data.settings.publicUrl || !!busy} onClick={() => void run('url', () => rpc.saveGrokBot({ publicUrl }), 'Saved')}>
            {spin('url')} Save
          </Button>
        </div>
        {data.mcpUrl && (
          <>
            <Hint>In Grok Bot, add a custom MCP server with this server URL and HTTP header:</Hint>
            <CopyCommand cmd={data.mcpUrl} />
            <CopyCommand cmd={data.header} />
          </>
        )}
      </Step>

      <Step n={2} title="Send it research">
        <div className="flex items-center justify-between gap-3">
          <span>Company research and people to reach</span>
          <Switch checked={data.settings.research} onCheckedChange={(research) => void run('research', () => rpc.saveGrokBot({ research }))} />
        </div>
        <div className="flex items-center justify-between gap-3">
          <span>Research on X</span>
          <Switch checked={data.settings.x} onCheckedChange={(x) => void run('x', () => rpc.saveGrokBot({ x }))} />
        </div>
        <Hint>These wait for Grok Bot instead of running on your AI here. Everything else stays here.</Hint>
      </Step>

      <Step n={3} title="Wake it when there’s work">
        <Hint>Ask your Bot to create a routine with these instructions and a webhook trigger, then paste the routine’s webhook URL and key here.</Hint>
        <div className="relative">
          <pre className="max-h-40 overflow-auto rounded-md border bg-muted/60 p-3 pr-10 font-mono text-xs whitespace-pre-wrap">{data.routine}</pre>
          <Button
            size="icon"
            variant="ghost"
            className="absolute top-1 right-1 size-7"
            aria-label="Copy instructions"
            onClick={() => {
              void navigator.clipboard.writeText(data.routine)
              setCopied(true)
              setTimeout(() => setCopied(false), 1500)
            }}
          >
            {copied ? <Check className="size-3.5" /> : <Copy className="size-3.5" />}
          </Button>
        </div>
        <Input value={webhookUrl} onChange={(e) => setWebhookUrl(e.target.value)} placeholder="Webhook URL (https://…)" />
        <Input type="password" value={key} onChange={(e) => setKey(e.target.value)} placeholder={data.hasKey ? 'Key saved (paste a new one to replace it)' : 'Key'} />
        <div className="flex gap-2">
          <Button
            variant="outline"
            disabled={(webhookUrl === data.settings.webhookUrl && !key.trim()) || !!busy}
            onClick={() => void run('hook', () => rpc.saveGrokBot({ webhookUrl, ...(key.trim() ? { webhookKey: key } : {}) }).then(() => setKey('')), 'Saved')}
          >
            {spin('hook')} Save
          </Button>
          <Button variant="ghost" disabled={!data.settings.webhookUrl || !data.hasKey || !!busy} onClick={() => void run('test', () => rpc.testGrokBot(), 'Grok Bot started a run. Its reply is in the Bot’s chat.')}>
            {spin('test')} Test
          </Button>
        </div>
        {data.wake && <Hint>{data.wake.ok ? `Woke it ${timeAgo(data.wake.at)}.` : `Last wake failed ${timeAgo(data.wake.at)}: ${data.wake.error}`}</Hint>}
        <Hint>Without a webhook, tasks still wait for it: ask your Bot to “check Sidedoor”.</Hint>
      </Step>

      <div className="flex flex-wrap items-center justify-between gap-2 border-t pt-3">
        <span className="text-xs text-muted-foreground">Grok Bot {status.join(' · ')}</span>
        <div className="flex gap-1">
          <Button size="sm" variant="ghost" disabled={!!busy} onClick={() => void run('rotate', () => rpc.rotateGrokBotToken(), 'New token. Update the header in Grok Bot.')}>
            {spin('rotate')} New token
          </Button>
          <Button size="sm" variant="ghost" disabled={!!busy} onClick={() => void run('off', () => rpc.setGrokBot({ on: false }), 'Grok Bot is disconnected. Its research runs here again.')}>
            {spin('off')} Turn off
          </Button>
        </div>
      </div>
    </div>
  )
}
