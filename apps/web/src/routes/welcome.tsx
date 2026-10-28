import { useQuery, useQueryClient, useSuspenseQuery } from '@tanstack/react-query'
import { createFileRoute, useNavigate } from '@tanstack/react-router'
import { ArrowLeft, ArrowRight, Check, DoorOpen, FileText, Loader2, PenLine } from 'lucide-react'
import { type ReactNode, useEffect, useMemo, useState } from 'react'
import { toast } from 'sonner'
import { AiConnections, providerState } from '~/components/app/ai-connect'
import { ChipsInput, PillSelect } from '~/components/app/chips'
import { ResumeImport } from '~/components/resume/import'
import { Button } from '~/components/ui/button'
import { Input } from '~/components/ui/input'
import { Switch } from '~/components/ui/switch'
import { Textarea } from '~/components/ui/textarea'
import { qo, rpc } from '~/lib/api'
import { desktop } from '~/lib/desktop'
import { cn } from '~/lib/utils'
import { COUNTRIES } from '@sidedoor/shared/countries'

export const Route = createFileRoute('/welcome')({
  loader: ({ context }) => context.queryClient.ensureQueryData(qo.settings()),
  component: Welcome,
})

const STEPS = [
  { id: 'welcome', label: 'Welcome' },
  { id: 'ai', label: 'Connect your AI' },
  { id: 'resume', label: 'Your resume' },
  { id: 'you', label: 'About you' },
  { id: 'search', label: 'What you want' },
  { id: 'sources', label: 'Where to look' },
  { id: 'notify', label: 'Staying in the loop' },
] as const
type StepId = (typeof STEPS)[number]['id']

/** Salary currency to start from, by country. */
const CURRENCY: Record<string, string> = { CA: 'CAD', GB: 'GBP', IE: 'EUR', DE: 'EUR', FR: 'EUR', NL: 'EUR', ES: 'EUR', PT: 'EUR', PL: 'PLN', SE: 'SEK', CH: 'CHF', IL: 'ILS', AE: 'AED', IN: 'INR', SG: 'SGD', JP: 'JPY', AU: 'AUD', NZ: 'NZD', BR: 'BRL', MX: 'MXN', AR: 'ARS', ZA: 'ZAR', NG: 'NGN', KE: 'KES', PH: 'PHP' }
const SENIORITY = ['Entry level', 'Mid level', 'Senior', 'Staff / Principal', 'Lead / Manager', 'Director', 'VP / Executive']
const LANES = ['AI', 'Developer tools', 'Fintech', 'Crypto & web3', 'Healthcare', 'Climate', 'Consumer', 'E-commerce', 'Education', 'Gaming', 'Security', 'Enterprise SaaS', 'Media', 'Nonprofit', 'Government']

function Welcome() {
  const { data } = useSuspenseQuery(qo.settings())
  const qc = useQueryClient()
  const nav = useNavigate()
  const saved = data.settings.onboarding.step as StepId
  const [step, setStep] = useState<StepId>(STEPS.some((s) => s.id === saved) ? saved : 'welcome')
  const i = STEPS.findIndex((s) => s.id === step)
  const go = (to: StepId) => {
    setStep(to)
    void rpc.updateSettings({ section: 'onboarding', patch: { step: to } })
    window.scrollTo({ top: 0 })
  }
  const next = () => (i < STEPS.length - 1 ? go(STEPS[i + 1]!.id) : void finish())
  const back = () => i > 0 && go(STEPS[i - 1]!.id)
  const finish = async () => {
    const r = await rpc.completeOnboarding({ done: true })
    await qc.invalidateQueries({ queryKey: ['settings'] })
    if (r.sources) toast.success(`You’re set. The scout is checking your ${r.sources} source${r.sources === 1 ? '' : 's'} now.`)
    else toast('You’re set. Add a job source on the Sources page so the scout has somewhere to look.')
    void nav({ to: '/' })
  }

  return (
    <div className="min-h-dvh bg-background">
      <div className="mx-auto flex max-w-5xl gap-10 px-6 py-10 max-md:flex-col max-md:gap-6 max-md:py-6">
        <aside className="w-52 shrink-0">
          <div className="mb-8 flex items-center gap-2 font-semibold">
            <DoorOpen className="size-5 text-primary" /> Sidedoor
          </div>
          <ol className="space-y-1 max-md:flex max-md:gap-1.5 max-md:space-y-0">
            {STEPS.map((s, j) => (
              <li key={s.id}>
                <button
                  type="button"
                  disabled={j > i}
                  onClick={() => go(s.id)}
                  className={cn(
                    'flex w-full items-center gap-2.5 rounded-md px-2 py-1.5 text-left text-sm transition-colors disabled:cursor-default max-md:px-0',
                    j === i ? 'text-foreground' : j < i ? 'text-muted-foreground hover:text-foreground' : 'text-muted-foreground/50',
                  )}
                >
                  <span className={cn('flex size-5 shrink-0 items-center justify-center rounded-full border text-[11px] tabular-nums', j === i && 'border-primary bg-primary text-primary-foreground', j < i && 'border-primary/40 text-primary')}>
                    {j < i ? <Check className="size-3" /> : j + 1}
                  </span>
                  <span className="max-md:hidden">{s.label}</span>
                </button>
              </li>
            ))}
          </ol>
        </aside>
        <main className="min-w-0 flex-1 pb-24">
          {step === 'welcome' && <StepWelcome onNext={next} />}
          {step === 'ai' && <StepAi onNext={next} onBack={back} />}
          {step === 'resume' && <StepResume onNext={next} onBack={back} />}
          {step === 'you' && <StepYou onNext={next} onBack={back} />}
          {step === 'search' && <StepSearch onNext={next} onBack={back} />}
          {step === 'sources' && <StepSources onNext={next} onBack={back} />}
          {step === 'notify' && <StepNotify onNext={next} onBack={back} last />}
        </main>
      </div>
    </div>
  )
}

function Step({ title, lead, children, onNext, onBack, nextLabel = 'Continue', nextDisabled, busy, skip, last }: { title: string; lead: ReactNode; children?: ReactNode; onNext: () => void | Promise<void>; onBack?: () => void; nextLabel?: string; nextDisabled?: boolean; busy?: boolean; skip?: () => void; last?: boolean }) {
  const [working, setWorking] = useState(false)
  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight text-balance">{title}</h1>
        <p className="mt-2 max-w-prose text-muted-foreground">{lead}</p>
      </div>
      {children}
      <div className="flex items-center gap-2 pt-2">
        {onBack && (
          <Button variant="ghost" onClick={onBack}>
            <ArrowLeft /> Back
          </Button>
        )}
        <div className="flex-1" />
        {skip && (
          <Button variant={nextDisabled ? 'outline' : 'ghost'} onClick={skip}>
            Skip for now
          </Button>
        )}
        {!(skip && nextDisabled) && <Button
          disabled={nextDisabled || busy || working}
          onClick={async () => {
            setWorking(true)
            try {
              await onNext()
            } finally {
              setWorking(false)
            }
          }}
        >
          {busy || working ? <Loader2 className="animate-spin" /> : null}
          {last ? 'Finish' : nextLabel} {!last && <ArrowRight />}
        </Button>}
      </div>
    </div>
  )
}

function StepWelcome({ onNext }: { onNext: () => void }) {
  return (
    <Step
      title="Find the right roles first, and apply to the person"
      lead="Sidedoor checks the job boards you choose every few minutes. Your AI scores each new posting against what you want, gets the good ones ready for you, and finds who's hiring, so you can write to them directly."
      onNext={onNext}
      nextLabel="Set it up"
    >
      <div className="max-w-xl rounded-xl border bg-card">
        <div className="border-b px-4 py-2 text-xs font-medium text-muted-foreground">A morning with Sidedoor</div>
        <ul className="divide-y text-sm">
          {[
            ['7:52', 'New match, 86', 'Staff Product Designer at Linear, posted 20 minutes ago'],
            ['8:00', 'Ready for you', 'Ramp: tailored resume, 9 form answers, and a cover letter to check'],
            ['8:00', 'Follow up', 'Priya at Stripe. You emailed her a week ago'],
          ].map(([t, k, d]) => (
            <li key={d} className="flex gap-3 px-4 py-2.5">
              <span className="w-10 shrink-0 text-muted-foreground tabular-nums">{t}</span>
              <span className="min-w-0">
                <span className="font-medium">{k}</span> <span className="text-muted-foreground">· {d}</span>
              </span>
            </li>
          ))}
        </ul>
      </div>
      <p className="max-w-xl text-sm text-muted-foreground">It runs on this computer and works through the AI you already use. It drafts and fills in; you review, send and submit.</p>
    </Step>
  )
}

function StepAi({ onNext, onBack }: { onNext: () => void; onBack: () => void }) {
  const { data } = useQuery(qo.aiStatus())
  const qc = useQueryClient()
  const ready = data?.providers.filter((p) => providerState(p) === 'ready') ?? []
  // Pick a default automatically when exactly one is ready.
  useEffect(() => {
    if (data && !data.default && ready.length > 0) void rpc.setDefaultAi({ provider: ready[0]!.id }).then(() => qc.invalidateQueries({ queryKey: ['aiStatus'] }))
  }, [data, ready, qc])
  return (
    <Step
      title="Connect your AI"
      lead="Sidedoor doesn't have its own AI. It uses the one you already pay for, through its command-line tool on this computer. Pick the one Sidedoor should use; you can mix them later in Settings."
      onNext={onNext}
      onBack={onBack}
      {...(ready.length === 0 ? { skip: onNext, nextDisabled: true } : {})}
    >
      <AiConnections />
      {ready.length === 0 && data && <p className="text-sm text-muted-foreground">Without an AI, Sidedoor can still track applications and people, but it can't score jobs or write anything.</p>}
    </Step>
  )
}

function StepResume({ onNext, onBack }: { onNext: () => void; onBack: () => void }) {
  const { data: resumes } = useQuery(qo.resumes())
  const { data: ai } = useQuery(qo.aiStatus())
  const qc = useQueryClient()
  const hasAi = !!ai?.default
  const existing = resumes?.find((r) => r.kind === 'base')
  const [mode, setMode] = useState<'import' | 'scratch' | null>(null)
  if (existing)
    return (
      <Step title="Your resume" lead="Your main resume is in. You can polish it and pick a design any time from the Resume page." onNext={onNext} onBack={onBack}>
        <div className="flex items-center gap-3 rounded-xl border p-4">
          <FileText className="size-5 text-muted-foreground" />
          <div className="min-w-0 flex-1">
            <div className="font-medium">{existing.title}</div>
            <div className="text-xs text-muted-foreground capitalize">{existing.theme} design</div>
          </div>
          <Check className="size-5 text-success" />
        </div>
      </Step>
    )
  return (
    <Step title="Your resume" lead="Your resume is where everything starts: triage scores jobs against it, and your AI tailors a copy of it for each application." onNext={onNext} onBack={onBack} skip={onNext} nextDisabled>
      <div className="grid gap-3 sm:grid-cols-2">
        <button type="button" onClick={() => setMode('import')} className={cn('rounded-xl border p-4 text-left transition-colors hover:border-foreground/30', mode === 'import' && 'border-primary ring-1 ring-primary')}>
          <FileText className="mb-2 size-5 text-muted-foreground" />
          <div className="font-medium">I have a resume</div>
          <p className="mt-1 text-sm text-muted-foreground">Upload a PDF or Word file. Your AI rebuilds it here, word for word, and fills in your experience.</p>
        </button>
        <button type="button" onClick={() => setMode('scratch')} className={cn('rounded-xl border p-4 text-left transition-colors hover:border-foreground/30', mode === 'scratch' && 'border-primary ring-1 ring-primary')}>
          <PenLine className="mb-2 size-5 text-muted-foreground" />
          <div className="font-medium">Start from scratch</div>
          <p className="mt-1 text-sm text-muted-foreground">Build one in the resume designer, section by section, with a template you like.</p>
        </button>
      </div>
      {mode === 'import' &&
        (hasAi ? (
          <ResumeImport
            onDone={() => {
              void qc.invalidateQueries({ queryKey: ['resumes'] })
              void qc.invalidateQueries({ queryKey: ['settings'] })
              toast.success('Resume imported')
            }}
          />
        ) : (
          <p className="text-sm text-muted-foreground">Importing needs a connected AI. Go back a step to connect one, or start from scratch.</p>
        ))}
      {mode === 'scratch' && (
        <Button
          onClick={async () => {
            await rpc.createResume({ title: 'Main resume', theme: 'modern' })
            await qc.invalidateQueries({ queryKey: ['resumes'] })
            toast.success('Created. You can fill it in from the Resume page after setup.')
          }}
        >
          Create a blank resume
        </Button>
      )}
    </Step>
  )
}

function StepYou({ onNext, onBack }: { onNext: () => void; onBack: () => void }) {
  const { data } = useSuspenseQuery(qo.settings())
  const qc = useQueryClient()
  const [you, setYou] = useState(data.settings.you)
  const link = (label: string) => you.links.find((l) => l.label.toLowerCase() === label.toLowerCase())?.url ?? ''
  const setLink = (label: string, url: string) => setYou((y) => ({ ...y, links: [...y.links.filter((l) => l.label.toLowerCase() !== label.toLowerCase()), ...(url ? [{ label, url }] : [])] }))
  return (
    <Step
      title="About you"
      lead="Used in drafts, application forms and the location filter. It stays on this computer."
      onBack={onBack}
      nextDisabled={!you.name.trim()}
      onNext={async () => {
        await rpc.updateSettings({ section: 'you', patch: you })
        // The next step starts "where you can work" from this country, so it must see the saved value.
        await qc.invalidateQueries({ queryKey: ['settings'] })
        onNext()
      }}
    >
      <div className="grid max-w-xl gap-4 sm:grid-cols-2">
        <Labeled label="Full name" className="sm:col-span-2">
          <Input value={you.name} onChange={(e) => setYou({ ...you, name: e.target.value })} autoFocus />
        </Labeled>
        <Labeled label="Email">
          <Input type="email" value={you.email} onChange={(e) => setYou({ ...you, email: e.target.value })} />
        </Labeled>
        <Labeled label="Phone">
          <Input value={you.phone} onChange={(e) => setYou({ ...you, phone: e.target.value })} />
        </Labeled>
        <Labeled label="City">
          <Input value={you.location} onChange={(e) => setYou({ ...you, location: e.target.value })} placeholder="e.g. Philadelphia, PA" />
        </Labeled>
        <Labeled label="Country">
          <select value={you.country} onChange={(e) => setYou({ ...you, country: e.target.value })} className="h-9 w-full rounded-md border border-input bg-transparent px-3 text-sm">
            <option value="">Choose…</option>
            {COUNTRIES.map(([code, name]) => (
              <option key={code} value={code}>
                {name}
              </option>
            ))}
          </select>
        </Labeled>
        <Labeled label="LinkedIn">
          <Input value={link('LinkedIn')} onChange={(e) => setLink('LinkedIn', e.target.value)} placeholder="linkedin.com/in/…" />
        </Labeled>
        <Labeled label="Website or portfolio">
          <Input value={link('Website')} onChange={(e) => setLink('Website', e.target.value)} placeholder="https://" />
        </Labeled>
      </div>
    </Step>
  )
}

function StepSearch({ onNext, onBack }: { onNext: () => void; onBack: () => void }) {
  const { data } = useSuspenseQuery(qo.settings())
  const qc = useQueryClient()
  const countryName0 = COUNTRIES.find(([c]) => c === data.settings.you.country)?.[1]
  // Start "where you can work" from the country picked a step ago.
  const [s, setS] = useState(() => {
    const cur = data.settings.search
    const currency = cur.currency === 'USD' ? (CURRENCY[data.settings.you.country] ?? 'USD') : cur.currency
    return { ...cur, currency, locations: cur.locations.length ? cur.locations : countryName0 ? [countryName0] : [] }
  })
  const [notes, setNotes] = useState('')
  const countryName = COUNTRIES.find(([c]) => c === data.settings.you.country)?.[1]
  return (
    <Step
      title="What are you looking for?"
      lead="Triage scores every new posting against this. Be as specific as you like; you can refine it in Settings, and your AI reads your own words too."
      onBack={onBack}
      nextDisabled={!s.roles.length}
      onNext={async () => {
        await rpc.updateSettings({ section: 'search', patch: s })
        if (notes.trim()) {
          const doc = await rpc.doc({ key: 'search' })
          await rpc.saveDoc({ key: 'search', body: `${doc.isDefault ? '# What I want\n' : doc.body.trimEnd()}\n\n${notes.trim()}\n` })
        }
        await rpc.applySearch()
        // Starter sources are suggested from these titles and lanes.
        await Promise.all([qc.invalidateQueries({ queryKey: ['settings'] }), qc.invalidateQueries({ queryKey: ['sources', 'starter'] })])
        onNext()
      }}
    >
      <div className="max-w-2xl space-y-5">
        <Labeled label="Job titles you want" hint="Press Enter after each.">
          <ChipsInput value={s.roles} onChange={(roles) => setS({ ...s, roles })} placeholder="e.g. Product Designer, UX Designer" />
        </Labeled>
        <Labeled label="Level">
          <PillSelect options={SENIORITY.map((v) => ({ value: v, label: v }))} value={s.seniority} onChange={(seniority) => setS({ ...s, seniority })} />
        </Labeled>
        <Labeled label="How you want to work">
          <PillSelect
            options={[
              { value: 'remote', label: 'Remote' },
              { value: 'hybrid', label: 'Hybrid' },
              { value: 'onsite', label: 'On-site' },
            ]}
            value={s.workModes}
            onChange={(workModes) => setS({ ...s, workModes: workModes as typeof s.workModes })}
          />
        </Labeled>
        <Labeled label="Where you can work" hint="Countries, regions or cities. Postings elsewhere are filtered out.">
          <ChipsInput value={s.locations} onChange={(locations) => setS({ ...s, locations })} placeholder="e.g. United States, New York" suggestions={countryName ? [countryName] : []} />
        </Labeled>
        <div className="flex gap-3">
          <Labeled label="Minimum base salary" className="flex-1">
            <Input type="number" inputMode="numeric" value={s.salaryMin ?? ''} onChange={(e) => setS({ ...s, salaryMin: e.target.value ? Number(e.target.value) : null })} placeholder="e.g. 150000" />
          </Labeled>
          <Labeled label="Currency" className="w-28">
            <Input value={s.currency} onChange={(e) => setS({ ...s, currency: e.target.value.toUpperCase().slice(0, 3) })} />
          </Labeled>
        </div>
        <Labeled label="Industries you like" hint="Optional.">
          <ChipsInput value={s.lanes} onChange={(lanes) => setS({ ...s, lanes })} suggestions={LANES} />
        </Labeled>
        <Labeled label="Dealbreakers" hint="Optional. e.g. “defense”, “gambling”, “no equity”.">
          <ChipsInput value={s.dealbreakers} onChange={(dealbreakers) => setS({ ...s, dealbreakers })} />
        </Labeled>
        <Labeled label="Anything else?" hint="Dream companies, team size, the kind of problems you want. In your own words.">
          <Textarea value={notes} onChange={(e) => setNotes(e.target.value)} className="min-h-24" />
        </Labeled>
      </div>
    </Step>
  )
}

function StepSources({ onNext, onBack }: { onNext: () => void; onBack: () => void }) {
  // Suggestions depend on the previous step, so always fetch them fresh and pick from that answer.
  const { data, isFetchedAfterMount } = useQuery({ ...qo.starterSources(), refetchOnMount: 'always' })
  const [picked, setPicked] = useState<Set<string> | null>(null)
  const [tag, setTag] = useState<string | null>(null)
  useEffect(() => {
    if (data && isFetchedAfterMount && !picked) setPicked(new Set([...data.feeds, ...data.companies].filter((e) => e.suggested || e.added).map((e) => e.id)))
  }, [data, isFetchedAfterMount, picked])
  // Suggested first, so what's picked is what you see.
  const first = <E extends { suggested: boolean; added: boolean }>(list: E[]) => [...list].sort((x, y) => Number(y.suggested || y.added) - Number(x.suggested || x.added))
  const feeds = useMemo(() => first(data?.feeds ?? []), [data])
  const companies = useMemo(() => first((data?.companies ?? []).filter((c) => !tag || c.tags.includes(tag))), [data, tag])
  if (!data || !picked) return <Loader2 className="animate-spin text-muted-foreground" />
  const toggle = (id: string) =>
    setPicked((p) => {
      const n = new Set(p)
      if (n.has(id)) n.delete(id)
      else n.add(id)
      return n
    })
  return (
    <Step
      title="Where should Sidedoor look?"
      lead="The scout checks these every few minutes and catches new postings fast. Start with a few; your AI adds more in your industries every day, and you can add any company's job board later."
      onBack={onBack}
      nextLabel={`Watch ${picked.size} source${picked.size === 1 ? '' : 's'}`}
      onNext={async () => {
        await rpc.addStarterSources({ ids: [...picked] })
        onNext()
      }}
    >
      <div className="space-y-6">
        <div>
          <h3 className="mb-2 text-sm font-medium">Job boards</h3>
          <div className="grid gap-1.5 sm:grid-cols-2">
            {feeds.map((f) => (
              <SourceRow key={f.id} name={f.name} tags={f.tags} on={picked.has(f.id)} onToggle={() => toggle(f.id)} />
            ))}
          </div>
        </div>
        <div>
          <div className="mb-2 flex flex-wrap items-center gap-1.5">
            <h3 className="mr-2 text-sm font-medium">Companies</h3>
            {[null, ...data.tags].map((t) => (
              <button key={t ?? 'all'} type="button" onClick={() => setTag(t)} className={cn('rounded-md px-2 py-0.5 text-xs transition-colors', tag === t ? 'bg-secondary text-foreground' : 'text-muted-foreground hover:text-foreground')}>
                {t ?? 'All'}
              </button>
            ))}
          </div>
          <div className="grid max-h-96 gap-1.5 overflow-y-auto pr-1 sm:grid-cols-2 lg:grid-cols-3">
            {companies.map((c) => (
              <SourceRow key={c.id} name={c.name} tags={c.tags} on={picked.has(c.id)} onToggle={() => toggle(c.id)} />
            ))}
          </div>
        </div>
      </div>
    </Step>
  )
}

function SourceRow({ name, tags, on, onToggle }: { name: string; tags: string[]; on: boolean; onToggle: () => void }) {
  return (
    <button type="button" onClick={onToggle} aria-pressed={on} className={cn('flex min-w-0 items-center gap-2.5 rounded-lg border px-3 py-2 text-left transition-colors', on ? 'border-primary/50 bg-primary/[0.04]' : 'hover:border-foreground/25')}>
      <span className={cn('flex size-4 shrink-0 items-center justify-center rounded border', on && 'border-primary bg-primary text-primary-foreground')}>{on && <Check className="size-3" />}</span>
      <span className="min-w-0 flex-1 truncate text-sm">{name}</span>
      <span className="max-w-[40%] shrink-0 truncate text-[11px] text-muted-foreground">{tags[0]}</span>
    </button>
  )
}

function StepNotify({ onNext, onBack, last }: { onNext: () => void | Promise<void>; onBack: () => void; last?: boolean }) {
  const { data } = useSuspenseQuery(qo.settings())
  const [n, setN] = useState(data.settings.notify)
  const [app, setApp] = useState(data.settings.app)
  const isDesktop = !!desktop
  return (
    <Step
      title="Staying in the loop"
      lead="Sidedoor tells you when a strong job is posted, a package is ready to review, or a follow-up is due."
      onBack={onBack}
      last={last}
      onNext={async () => {
        await rpc.updateSettings({ section: 'notify', patch: n })
        await rpc.updateSettings({ section: 'app', patch: app })
        await desktop?.setLaunchAtLogin(app.launchAtLogin)
        await onNext()
      }}
    >
      <div className="max-w-xl divide-y rounded-xl border">
        <Toggle label="Desktop notifications" hint="For strong new jobs, finished packages and due follow-ups." on={n.desktop} onChange={(desktop) => setN({ ...n, desktop })} />
        <Toggle label="Morning digest" hint={`One summary each morning at ${n.digestHour}:00.`} on={n.digest} onChange={(digest) => setN({ ...n, digest })} />
        {isDesktop && <Toggle label="Keep running when I close the window" hint="The scout keeps checking for jobs from the menu bar or tray." on={app.runInBackground} onChange={(runInBackground) => setApp({ ...app, runInBackground })} />}
        {isDesktop && <Toggle label="Start Sidedoor when I log in" on={app.launchAtLogin} onChange={(launchAtLogin) => setApp({ ...app, launchAtLogin })} />}
      </div>
      <p className="text-sm text-muted-foreground">Want alerts on your phone too? Set up phone notifications in Settings after this.</p>
    </Step>
  )
}

function Toggle({ label, hint, on, onChange }: { label: string; hint?: string; on: boolean; onChange: (v: boolean) => void }) {
  return (
    <label className="flex items-center justify-between gap-4 px-4 py-3">
      <span>
        <span className="text-sm font-medium">{label}</span>
        {hint && <span className="block text-xs text-muted-foreground">{hint}</span>}
      </span>
      <Switch checked={on} onCheckedChange={onChange} />
    </label>
  )
}

function Labeled({ label, hint, children, className }: { label: string; hint?: string; children: ReactNode; className?: string }) {
  return (
    <div className={cn('space-y-1.5', className)}>
      <div className="text-sm font-medium">{label}</div>
      {children}
      {hint && <p className="text-xs text-muted-foreground">{hint}</p>}
    </div>
  )
}
