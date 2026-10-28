import { useQuery, useQueryClient, useSuspenseQuery } from '@tanstack/react-query'
import { createFileRoute, Link } from '@tanstack/react-router'
import { BellRing, ExternalLink, Loader2, RefreshCw } from 'lucide-react'
import QRCode from 'qrcode'
import { type ReactNode, useEffect, useState } from 'react'
import { toast } from 'sonner'
import { AiConnections, CopyCommand } from '~/components/app/ai-connect'
import { ChipsInput, PillSelect } from '~/components/app/chips'
import { GrokBotRow } from '~/components/app/grok-bot'
import { Button } from '~/components/ui/button'
import { Input } from '~/components/ui/input'
import { Switch } from '~/components/ui/switch'
import { Textarea } from '~/components/ui/textarea'
import { qo, rpc } from '~/lib/api'
import { desktop, type UpdateState } from '~/lib/desktop'
import { cn } from '~/lib/utils'
import { COUNTRIES } from '@sidedoor/shared/countries'
import { timeAgo } from '@sidedoor/shared/format'

type SettingsData = Awaited<ReturnType<typeof rpc.settings>>
type S = SettingsData['settings']

const SECTIONS = [
  { id: 'you', label: 'You' },
  { id: 'search', label: 'Job search' },
  { id: 'ai', label: 'AI' },
  { id: 'notifications', label: 'Notifications' },
  { id: 'devices', label: 'Phone & other devices' },
  { id: 'integrations', label: 'Integrations' },
  { id: 'appearance', label: 'Appearance' },
  { id: 'about', label: 'About' },
] as const
type SectionId = (typeof SECTIONS)[number]['id']

export const Route = createFileRoute('/settings')({
  validateSearch: (s: Record<string, unknown>): { section?: SectionId } => (typeof s.section === 'string' && SECTIONS.some((x) => x.id === s.section) ? { section: s.section as SectionId } : {}),
  loader: ({ context }) => context.queryClient.ensureQueryData(qo.settings()),
  component: SettingsPage,
})

function SettingsPage() {
  const { section = 'you' } = Route.useSearch()
  const nav = Route.useNavigate()
  return (
    <div className="flex gap-8 max-md:flex-col max-md:gap-4">
      <nav className="w-48 shrink-0 max-md:w-auto">
        <h1 className="mb-4 text-2xl font-semibold tracking-tight">Settings</h1>
        <ul className="space-y-0.5 max-md:flex max-md:gap-1 max-md:overflow-x-auto max-md:space-y-0">
          {SECTIONS.map((s) => (
            <li key={s.id}>
              <button
                type="button"
                onClick={() => void nav({ search: { section: s.id }, replace: true })}
                className={cn('w-full rounded-md px-2.5 py-1.5 text-left text-sm whitespace-nowrap transition-colors', section === s.id ? 'bg-secondary font-medium text-foreground' : 'text-muted-foreground hover:text-foreground')}
              >
                {s.label}
              </button>
            </li>
          ))}
        </ul>
      </nav>
      <div className="min-w-0 max-w-2xl flex-1 space-y-6">
        {section === 'you' && <YouSection />}
        {section === 'search' && <SearchSection />}
        {section === 'ai' && <AiSection />}
        {section === 'notifications' && <NotifySection />}
        {section === 'devices' && <DevicesSection />}
        {section === 'integrations' && <IntegrationsSection />}
        {section === 'appearance' && <AppearanceSection />}
        {section === 'about' && <AboutSection />}
      </div>
    </div>
  )
}

// ------------------------------------------------------------------ building blocks

function Card({ title, desc, children, footer }: { title: string; desc?: ReactNode; children: ReactNode; footer?: ReactNode }) {
  return (
    <section className="rounded-xl border bg-card">
      <div className="space-y-4 p-5">
        <div>
          <h2 className="font-semibold">{title}</h2>
          {desc && <div className="mt-0.5 text-sm text-muted-foreground">{desc}</div>}
        </div>
        {children}
      </div>
      {footer && <div className="flex items-center justify-end gap-2 border-t px-5 py-3">{footer}</div>}
    </section>
  )
}

function Field({ label, hint, children, className }: { label: string; hint?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <div className={cn('space-y-1.5', className)}>
      <div className="text-sm font-medium">{label}</div>
      {children}
      {hint && <p className="text-xs text-muted-foreground">{hint}</p>}
    </div>
  )
}

function Row({ label, hint, children }: { label: string; hint?: ReactNode; children: ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-4">
      <div className="min-w-0">
        <div className="text-sm">{label}</div>
        {hint && <div className="text-xs text-muted-foreground">{hint}</div>}
      </div>
      <div className="shrink-0">{children}</div>
    </div>
  )
}

function NumberInput({ value, onChange, min, max, suffix, className }: { value: number; onChange: (n: number) => void; min?: number; max?: number; suffix?: string; className?: string }) {
  return (
    <div className="flex items-center gap-1.5">
      <Input type="number" inputMode="numeric" min={min} max={max} value={value} onChange={(e) => onChange(Number(e.target.value) || 0)} className={cn('w-20 text-right tabular-nums', className)} />
      {suffix && <span className="text-xs text-muted-foreground">{suffix}</span>}
    </div>
  )
}

/** Edit one settings section locally; Save writes it. */
function useSection<K extends keyof S>(key: K) {
  const { data } = useSuspenseQuery(qo.settings())
  const qc = useQueryClient()
  const [v, setV] = useState<S[K]>(data.settings[key])
  const [saving, setSaving] = useState(false)
  useEffect(() => setV(data.settings[key]), [data.settings, key])
  const dirty = JSON.stringify(v) !== JSON.stringify(data.settings[key])
  const save = async (extra?: () => Promise<unknown>) => {
    setSaving(true)
    try {
      await rpc.updateSettings({ section: key as string, patch: v as Record<string, unknown> })
      await extra?.()
      await qc.invalidateQueries({ queryKey: ['settings'] })
      toast.success('Saved')
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e))
    } finally {
      setSaving(false)
    }
  }
  const set = (patch: Partial<S[K]>) => setV((cur) => ({ ...cur, ...patch }))
  return { v, set, setV, save, saving, dirty, all: data }
}

function SaveBar({ dirty, saving, onSave }: { dirty: boolean; saving: boolean; onSave: () => void }) {
  return (
    <Button onClick={onSave} disabled={!dirty || saving} size="sm">
      {saving && <Loader2 className="animate-spin" />} Save
    </Button>
  )
}

// ------------------------------------------------------------------ sections

function YouSection() {
  const { v, set, save, saving, dirty } = useSection('you')
  return (
    <>
      <Card title="You" desc="Used in drafts, form answers and the location filter." footer={<SaveBar dirty={dirty} saving={saving} onSave={() => void save()} />}>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Full name" className="sm:col-span-2">
            <Input value={v.name} onChange={(e) => set({ name: e.target.value })} />
          </Field>
          <Field label="Email">
            <Input value={v.email} onChange={(e) => set({ email: e.target.value })} />
          </Field>
          <Field label="Phone">
            <Input value={v.phone} onChange={(e) => set({ phone: e.target.value })} />
          </Field>
          <Field label="City">
            <Input value={v.location} onChange={(e) => set({ location: e.target.value })} />
          </Field>
          <Field label="Country">
            <select value={v.country} onChange={(e) => set({ country: e.target.value })} className="h-9 w-full rounded-md border border-input bg-transparent px-3 text-sm">
              <option value="">Choose…</option>
              {COUNTRIES.map(([code, name]) => (
                <option key={code} value={code}>
                  {name}
                </option>
              ))}
              {v.country && !COUNTRIES.some(([c]) => c === v.country) && <option value={v.country}>{v.country}</option>}
            </select>
          </Field>
        </div>
        <Field label="Links">
          <div className="space-y-1.5">
            {v.links.map((l, i) => (
              <div key={i} className="flex gap-1.5">
                <Input className="w-32" value={l.label} onChange={(e) => set({ links: v.links.map((x, j) => (j === i ? { ...x, label: e.target.value } : x)) })} />
                <Input className="flex-1" value={l.url} onChange={(e) => set({ links: v.links.map((x, j) => (j === i ? { ...x, url: e.target.value } : x)) })} />
                <Button variant="ghost" size="sm" onClick={() => set({ links: v.links.filter((_, j) => j !== i) })}>
                  Remove
                </Button>
              </div>
            ))}
            <Button variant="ghost" size="sm" onClick={() => set({ links: [...v.links, { label: '', url: '' }] })}>
              Add link
            </Button>
          </div>
        </Field>
      </Card>
      <Card title="Your profile" desc="What your AI knows about you: your experience, what you want, your standard answers and how you write.">
        <Button asChild variant="outline" size="sm">
          <Link to="/profile">Open profile</Link>
        </Button>
      </Card>
    </>
  )
}

function SearchSection() {
  const search = useSection('search')
  const scout = useSection('scout')
  const triage = useSection('triage')
  const [advanced, setAdvanced] = useState(false)
  const s = search.v
  return (
    <>
      <Card
        title="What you want"
        desc={
          <>
            Triage scores every posting against these choices and your own words in <Link to="/profile/$key" params={{ key: 'search' }} className="text-primary hover:underline">What I want</Link>.
          </>
        }
        footer={<SaveBar dirty={search.dirty} saving={search.saving} onSave={() => void search.save(() => rpc.applySearch())} />}
      >
        <Field label="Job titles">
          <ChipsInput value={s.roles} onChange={(roles) => search.set({ roles })} />
        </Field>
        <Field label="Work arrangement">
          <PillSelect
            options={[
              { value: 'remote', label: 'Remote' },
              { value: 'hybrid', label: 'Hybrid' },
              { value: 'onsite', label: 'On-site' },
            ]}
            value={s.workModes}
            onChange={(workModes) => search.set({ workModes: workModes as typeof s.workModes })}
          />
        </Field>
        <Field label="Where you can work">
          <ChipsInput value={s.locations} onChange={(locations) => search.set({ locations })} />
        </Field>
        <div className="flex gap-3">
          <Field label="Minimum base salary" className="flex-1">
            <Input type="number" value={s.salaryMin ?? ''} onChange={(e) => search.set({ salaryMin: e.target.value ? Number(e.target.value) : null })} />
          </Field>
          <Field label="Currency" className="w-28">
            <Input value={s.currency} onChange={(e) => search.set({ currency: e.target.value.toUpperCase().slice(0, 3) })} />
          </Field>
        </div>
        <Field label="Industries">
          <ChipsInput value={s.lanes} onChange={(lanes) => search.set({ lanes })} />
        </Field>
        <Field label="Dealbreakers">
          <ChipsInput value={s.dealbreakers} onChange={(dealbreakers) => search.set({ dealbreakers })} />
        </Field>
      </Card>

      <Card title="Scoring" desc="When a posting is worth your time." footer={<SaveBar dirty={triage.dirty} saving={triage.saving} onSave={() => void triage.save()} />}>
        <Row label="Prepare an application at" hint="Postings at or above this fit score go to your pipeline.">
          <NumberInput value={triage.v.minFitScore} onChange={(minFitScore) => triage.set({ minFitScore })} suffix="/ 100" />
        </Row>
        <Row label="Show as a maybe at" hint="Between this and the line above, you decide.">
          <NumberInput value={triage.v.maybeFitScore} onChange={(maybeFitScore) => triage.set({ maybeFitScore })} suffix="/ 100" />
        </Row>
        <Row label="Score new postings automatically">
          <Switch checked={triage.v.enabled} onCheckedChange={(enabled) => triage.set({ enabled })} />
        </Row>
      </Card>

      <Card title="Scout" desc="How often job sources are checked. Dream companies are checked more often." footer={<SaveBar dirty={scout.dirty} saving={scout.saving} onSave={() => void scout.save()} />}>
        <Row label="Dream companies every">
          <NumberInput value={scout.v.hotIntervalMin} min={1} onChange={(hotIntervalMin) => scout.set({ hotIntervalMin })} suffix="min" />
        </Row>
        <Row label="Everything else every">
          <NumberInput value={scout.v.normalIntervalMin} min={2} onChange={(normalIntervalMin) => scout.set({ normalIntervalMin })} suffix="min" />
        </Row>
        <Row label="Ignore postings older than">
          <NumberInput value={scout.v.maxAgeDays} onChange={(maxAgeDays) => scout.set({ maxAgeDays })} suffix="days" />
        </Row>
        <Row label="Scout is on">
          <Switch checked={scout.v.enabled} onCheckedChange={(enabled) => scout.set({ enabled })} />
        </Row>
        <button type="button" onClick={() => setAdvanced(!advanced)} className="text-xs text-muted-foreground hover:text-foreground">
          {advanced ? 'Hide' : 'Show'} filter patterns
        </button>
        {advanced && (
          <div className="space-y-3">
            <p className="text-xs text-muted-foreground">Cheap filters that run before AI triage, generated from your choices above. Regular expressions, case-insensitive. Saving “What you want” regenerates them.</p>
            <Field label="Titles to include (one per line; empty = all)">
              <Textarea className="min-h-24 font-mono text-xs" value={scout.v.titleInclude.join('\n')} onChange={(e) => scout.set({ titleInclude: e.target.value.split('\n').filter(Boolean) })} />
            </Field>
            <Field label="Titles to exclude">
              <Textarea className="min-h-16 font-mono text-xs" value={scout.v.titleExclude.join('\n')} onChange={(e) => scout.set({ titleExclude: e.target.value.split('\n').filter(Boolean) })} />
            </Field>
            <Field label="Places you can work">
              <Textarea className="min-h-16 font-mono text-xs" value={scout.v.locationOk} onChange={(e) => scout.set({ locationOk: e.target.value })} />
            </Field>
            <Field label="Places you can't (applies to “Remote – <place>”)">
              <Textarea className="min-h-16 font-mono text-xs" value={scout.v.locationBlock} onChange={(e) => scout.set({ locationBlock: e.target.value })} />
            </Field>
          </div>
        )}
      </Card>
    </>
  )
}

const JOB_LABELS: Record<string, string> = {
  triage: 'Scoring new jobs',
  prep: 'Preparing applications',
  research: 'Researching companies and people',
  outreach: 'Drafting outreach',
  editor: 'Editing pass on drafts',
  match: 'Resume match',
  fill: 'Filling application forms',
  chat: 'Chat',
  discover: 'Finding new job sources',
  funding: 'Funding radar',
  x: 'Research on X',
  import: 'Importing resumes',
}

function AiSection() {
  const { data } = useQuery(qo.aiStatus())
  const prep = useSection('prep')
  const research = useSection('research')
  const editor = useSection('editor')
  const worker = useSection('worker')
  const funding = useSection('funding')
  const discover = useSection('discover')
  const qc = useQueryClient()
  const ready = data?.providers.filter((p) => p.installed && p.auth !== 'signed-out') ?? []
  return (
    <>
      <Card title="Your AI" desc="Sidedoor runs on the AI tools you already use. Pick a default; you can send particular jobs to another one below.">
        <AiConnections extra={<GrokBotRow />} />
      </Card>
      {data && ready.length > 1 && (
        <Card title="Who does what" desc="Every job uses your default AI unless you send it elsewhere here.">
          <details>
            <summary className="cursor-pointer text-sm text-muted-foreground hover:text-foreground">Choose an AI per kind of job</summary>
          <div className="mt-3 divide-y">
            {Object.entries(JOB_LABELS).map(([job, label]) => {
              const cur = data.jobs[job as keyof typeof data.jobs]
              const provider = data.providers.find((p) => p.id === (cur?.provider ?? data.default))
              return (
                <div key={job} className="flex items-center gap-2 py-2">
                  <span className="min-w-0 flex-1 text-sm">{label}</span>
                  <select
                    value={cur?.provider ?? ''}
                    onChange={(e) => void rpc.setJobAi({ job, provider: (e.target.value || null) as never, model: '' }).then(() => qc.invalidateQueries({ queryKey: ['aiStatus'] }))}
                    className="h-8 rounded-md border border-input bg-transparent px-2 text-sm"
                  >
                    <option value="">Default</option>
                    {ready.map((p) => (
                      <option key={p.id} value={p.id}>
                        {p.name}
                      </option>
                    ))}
                  </select>
                  <select
                    value={cur?.model ?? ''}
                    onChange={(e) => void rpc.setJobAi({ job, provider: cur?.provider ?? null, model: e.target.value }).then(() => qc.invalidateQueries({ queryKey: ['aiStatus'] }))}
                    className="h-8 w-44 rounded-md border border-input bg-transparent px-2 text-sm"
                  >
                    <option value="">Model: automatic</option>
                    {(provider?.models ?? []).filter((m) => m.id).map((m) => (
                      <option key={m.id} value={m.id}>
                        {m.label}
                      </option>
                    ))}
                  </select>
                </div>
              )
            })}
          </div>
          </details>
        </Card>
      )}
      <Card
        title="Automation"
        desc="What your AI does on its own. Everything it writes waits for your review."
        footer={
          <SaveBar
            dirty={prep.dirty || research.dirty || editor.dirty || worker.dirty || funding.dirty || discover.dirty}
            saving={prep.saving || research.saving}
            onSave={() => void Promise.all([prep.dirty && prep.save(), research.dirty && research.save(), editor.dirty && editor.save(), worker.dirty && worker.save(), funding.dirty && funding.save(), discover.dirty && discover.save()])}
          />
        }
      >
        <Row label="Prepare applications for strong fits" hint="A tailored resume, form answers and a cover letter, ready to review.">
          <Switch checked={prep.v.auto} onCheckedChange={(auto) => prep.set({ auto })} />
        </Row>
        <Row label="Research the company and find people" hint="When you start pursuing a job.">
          <Switch checked={research.v.auto} onCheckedChange={(auto) => research.set({ auto })} />
        </Row>
        <Row label="Second editing pass on drafts" hint="A separate, light edit against your writing style.">
          <Switch checked={editor.v.enabled} onCheckedChange={(enabled) => editor.set({ enabled })} />
        </Row>
        <Row label="Find new job sources every day">
          <Switch checked={discover.v.enabled} onCheckedChange={(enabled) => discover.set({ enabled })} />
        </Row>
        <Row label="Watch funding news" hint="Companies that just raised often hire before they post.">
          <Switch checked={funding.v.enabled} onCheckedChange={(enabled) => funding.set({ enabled })} />
        </Row>
        <Row label="Pause packages when this many await review">
          <NumberInput value={prep.v.maxAwaitingReview} onChange={(maxAwaitingReview) => prep.set({ maxAwaitingReview })} />
        </Row>
        <Row label="Resume page limit">
          <NumberInput value={prep.v.maxPages} min={1} max={3} onChange={(maxPages) => prep.set({ maxPages })} suffix="pages" />
        </Row>
        <Row label="AI jobs at once" hint="Keeps your subscription usage sane.">
          <NumberInput value={worker.v.concurrency} min={1} max={6} onChange={(concurrency) => worker.set({ concurrency })} />
        </Row>
        <Row label="Pause all AI work">
          <Switch checked={worker.v.paused} onCheckedChange={(paused) => worker.set({ paused })} />
        </Row>
      </Card>
      <OtherAgents />
    </>
  )
}

function OtherAgents() {
  const { data } = useQuery(qo.connectInfo())
  if (!data) return null
  return (
    <Card title="Other AI apps" desc="Any app that speaks MCP (Claude Desktop, Cursor, and others) can use Sidedoor. Add this to its MCP settings.">
      <pre className="overflow-x-auto rounded-md border bg-muted/60 p-3 font-mono text-xs">{data.json}</pre>
      <details className="text-sm">
        <summary className="cursor-pointer text-muted-foreground">Connect over HTTP instead</summary>
        <div className="mt-2 space-y-1.5">
          <CopyCommand cmd={data.http.url} />
          <CopyCommand cmd={data.http.header} />
          <p className="text-xs text-muted-foreground">Keep the token private: anything with it can read and change your job search.</p>
        </div>
      </details>
    </Card>
  )
}

function NotifySection() {
  const { v, set, save, saving, dirty, all } = useSection('notify')
  const [topic, setTopic] = useState(v.ntfyTopic)
  const [testing, setTesting] = useState(false)
  return (
    <>
      <Card title="Notifications" footer={<SaveBar dirty={dirty} saving={saving} onSave={() => void save()} />}>
        <Row label="Desktop notifications">
          <Switch checked={v.desktop} onCheckedChange={(desktop) => set({ desktop })} />
        </Row>
        <Row label="Notify me right away about jobs scoring" hint="Only fresh postings.">
          <NumberInput value={v.hotFitScore} onChange={(hotFitScore) => set({ hotFitScore })} suffix="or more" />
        </Row>
        <Row label="Morning digest">
          <div className="flex items-center gap-2">
            <NumberInput value={v.digestHour} min={0} max={23} onChange={(digestHour) => set({ digestHour })} suffix=":00" className="w-16" />
            <Switch checked={v.digest} onCheckedChange={(digest) => set({ digest })} />
          </div>
        </Row>
        <Row label="Quiet hours" hint="Notifications still arrive, silently.">
          <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
            <NumberInput value={v.quietStart} min={0} max={23} onChange={(quietStart) => set({ quietStart })} className="w-16" /> to
            <NumberInput value={v.quietEnd} min={0} max={23} onChange={(quietEnd) => set({ quietEnd })} className="w-16" />
          </div>
        </Row>
      </Card>
      <Card
        title="Phone notifications"
        desc={
          <>
            Through <a href="https://ntfy.sh" target="_blank" rel="noreferrer" className="text-primary hover:underline">ntfy</a>, a free push app for iPhone and Android. Install it, subscribe to the topic below, then send a test.
          </>
        }
      >
        <Row label="Send to my phone">
          <Switch
            checked={v.ntfyEnabled}
            onCheckedChange={(ntfyEnabled) => {
              const t = topic || `sidedoor-${crypto.randomUUID().replace(/-/g, '').slice(0, 16)}`
              setTopic(t)
              set({ ntfyEnabled, ntfyTopic: t })
            }}
          />
        </Row>
        {v.ntfyEnabled && (
          <>
            <Field label="Topic" hint="A long random name is what keeps it private on the public ntfy server.">
              <CopyCommand cmd={v.ntfyTopic} />
            </Field>
            <Field label="Server">
              <Input value={v.ntfyServer} onChange={(e) => set({ ntfyServer: e.target.value })} />
            </Field>
            <Button
              size="sm"
              variant="outline"
              disabled={testing || dirty}
              onClick={async () => {
                setTesting(true)
                try {
                  const r = await rpc.testNotification()
                  if (r && 'ok' in r && !r.ok) toast.error(`ntfy refused it: ${r.error}`)
                  else toast.success('Sent. Check your phone.')
                } finally {
                  setTesting(false)
                }
              }}
            >
              <BellRing /> Send a test
            </Button>
            {dirty && <p className="text-xs text-muted-foreground">Save first, then test.</p>}
          </>
        )}
        {!all.secrets.ntfy && v.ntfyEnabled && <p className="text-xs text-muted-foreground">Using your own ntfy server with access control? Add its token under Integrations.</p>}
      </Card>
    </>
  )
}

function DevicesSection() {
  const app = useSection('app')
  const { data: access, refetch } = useQuery(qo.access())
  const [qr, setQr] = useState<string | null>(null)
  const link = access?.links[0]
  useEffect(() => {
    if (link) void QRCode.toDataURL(link, { margin: 1, width: 220 }).then(setQr)
    else setQr(null)
  }, [link])
  return (
    <>
      <Card
        title="Use Sidedoor from your phone"
        desc="Sidedoor runs on this computer. To reach it from your phone, either let it listen on your home network, or put it behind a private network like Tailscale and give that address here."
        footer={<SaveBar dirty={app.dirty} saving={app.saving} onSave={() => void app.save(() => refetch())} />}
      >
        <Row label="Allow devices on my network" hint="Restart Sidedoor after changing this.">
          <Switch checked={app.v.allowNetwork} onCheckedChange={(allowNetwork) => app.set({ allowNetwork })} />
        </Row>
        <Field label="Address other devices use (optional)" hint="e.g. https://my-laptop.tailnet.ts.net. Links in phone notifications point here too.">
          <Input value={app.v.publicUrl} onChange={(e) => app.set({ publicUrl: e.target.value })} placeholder="https://" />
        </Field>
      </Card>
      <Card title="Pair a device" desc="Open this link on the device (or scan the code). It signs that browser in. Keep it private.">
        {!access?.links.length ? (
          <p className="text-sm text-muted-foreground">Turn on network access or add an address above to get a pairing link.</p>
        ) : (
          <div className="flex flex-wrap items-start gap-5">
            {qr && <img src={qr} alt="Pairing QR code" className="size-44 rounded-lg border bg-white p-1" />}
            <div className="min-w-0 flex-1 space-y-2">
              {access.links.map((l) => (
                <CopyCommand key={l} cmd={l} />
              ))}
              <Button
                size="sm"
                variant="ghost"
                onClick={async () => {
                  if (!confirm('Sign out every paired phone and browser? You will need to pair them again.')) return
                  await rpc.rotateAccess()
                  await refetch()
                  toast.success('Paired devices signed out')
                }}
              >
                <RefreshCw /> Sign out all devices
              </Button>
            </div>
          </div>
        )}
      </Card>
    </>
  )
}

function IntegrationsSection() {
  const { data } = useSuspenseQuery(qo.settings())
  const qc = useQueryClient()
  const [hunter, setHunter] = useState('')
  const [ntfy, setNtfy] = useState('')
  const saveSecret = async (name: 'hunter-api-key' | 'ntfy-token', value: string) => {
    await rpc.setSecret({ name, value })
    await qc.invalidateQueries({ queryKey: ['settings'] })
    toast.success(value ? 'Saved' : 'Removed')
  }
  return (
    <>
      <Card
        title="Hunter.io"
        desc={
          <>
            Optional. Finds and verifies work email addresses. The free plan covers 25 searches a month. <a href="https://hunter.io/api-keys" target="_blank" rel="noreferrer" className="inline-flex items-center gap-0.5 text-primary hover:underline">Get a key <ExternalLink className="size-3" /></a>
          </>
        }
      >
        {data.secrets.hunter ? (
          <Row label="Connected">
            <Button size="sm" variant="ghost" onClick={() => void saveSecret('hunter-api-key', '')}>
              Remove
            </Button>
          </Row>
        ) : (
          <div className="flex gap-2">
            <Input type="password" value={hunter} onChange={(e) => setHunter(e.target.value)} placeholder="API key" />
            <Button disabled={!hunter.trim()} onClick={() => void saveSecret('hunter-api-key', hunter).then(() => setHunter(''))}>
              Save
            </Button>
          </div>
        )}
      </Card>
      <Card title="ntfy access token" desc="Only needed for a private ntfy server.">
        {data.secrets.ntfy ? (
          <Row label="Set">
            <Button size="sm" variant="ghost" onClick={() => void saveSecret('ntfy-token', '')}>
              Remove
            </Button>
          </Row>
        ) : (
          <div className="flex gap-2">
            <Input type="password" value={ntfy} onChange={(e) => setNtfy(e.target.value)} placeholder="tk_…" />
            <Button disabled={!ntfy.trim()} onClick={() => void saveSecret('ntfy-token', ntfy).then(() => setNtfy(''))}>
              Save
            </Button>
          </div>
        )}
      </Card>
    </>
  )
}

function AppearanceSection() {
  const app = useSection('app')
  return (
    <Card title="Appearance">
      <Row label="Theme">
        <div className="flex gap-1">
          {(['system', 'light', 'dark'] as const).map((t) => (
            <Button
              key={t}
              size="sm"
              variant={app.v.theme === t ? 'default' : 'outline'}
              onClick={() => {
                app.set({ theme: t })
                void rpc.updateSettings({ section: 'app', patch: { theme: t } })
              }}
              className="capitalize"
            >
              {t}
            </Button>
          ))}
        </div>
      </Row>
      {desktop && (
        <>
          <Row label="Keep running when the window is closed" hint="The scout keeps checking from the tray.">
            <Switch
              checked={app.v.runInBackground}
              onCheckedChange={(runInBackground) => {
                app.set({ runInBackground })
                void rpc.updateSettings({ section: 'app', patch: { runInBackground } })
              }}
            />
          </Row>
          <Row label="Start when I log in">
            <Switch
              checked={app.v.launchAtLogin}
              onCheckedChange={(launchAtLogin) => {
                app.set({ launchAtLogin })
                void rpc.updateSettings({ section: 'app', patch: { launchAtLogin } })
                void desktop?.setLaunchAtLogin(launchAtLogin)
              }}
            />
          </Row>
        </>
      )}
    </Card>
  )
}

function AboutSection() {
  const { data } = useSuspenseQuery(qo.settings())
  const [update, setUpdate] = useState<UpdateState | null>(null)
  useEffect(() => {
    if (!desktop) return
    void desktop.update.get().then(setUpdate)
    return desktop.update.onChange(setUpdate)
  }, [])
  return (
    <>
      <Card title="Sidedoor" desc={data.build ? `Version ${data.version}, built from ${data.build.commit.slice(0, 7)} ${timeAgo(data.build.builtAt)}` : `Version ${data.version}`}>
        {desktop && update && (
          <div className="flex items-center gap-3">
            <span className="text-sm text-muted-foreground">
              {update.state === 'available' && `Version ${update.version} is available.`}
              {update.state === 'downloading' && `Downloading… ${Math.round(update.percent)}%`}
              {update.state === 'ready' && `Version ${update.version} is ready to install.`}
              {update.state === 'none' && 'You have the latest version.'}
              {update.state === 'checking' && 'Checking…'}
              {update.state === 'error' && `Update check failed: ${update.message}`}
              {update.state === 'disabled' && 'Updates are managed by your package manager.'}
            </span>
            {(update.state === 'idle' || update.state === 'none' || update.state === 'error') && (
              <Button size="sm" variant="outline" onClick={() => void desktop?.update.check()}>
                Check for updates
              </Button>
            )}
            {update.state === 'available' && (
              <Button size="sm" onClick={() => void desktop?.update.download()}>
                Download
              </Button>
            )}
            {update.state === 'ready' && (
              <Button size="sm" onClick={() => void desktop?.update.install()}>
                Restart and update
              </Button>
            )}
          </div>
        )}
        <Row label="Your data" hint="Everything Sidedoor stores lives in this folder.">
          <div className="flex items-center gap-2">
            <code className="rounded bg-muted px-1.5 py-0.5 text-xs">{data.home}</code>
            {desktop && (
              <Button size="sm" variant="ghost" onClick={() => void desktop?.openPath(data.home)}>
                Open
              </Button>
            )}
          </div>
        </Row>
      </Card>
      <Card title="Start over" desc="Run the setup again. Nothing is deleted.">
        <Button
          size="sm"
          variant="outline"
          onClick={async () => {
            await rpc.completeOnboarding({ done: false })
            await rpc.updateSettings({ section: 'onboarding', patch: { step: 'welcome' } })
            window.location.href = '/welcome'
          }}
        >
          Run setup again
        </Button>
      </Card>
    </>
  )
}
