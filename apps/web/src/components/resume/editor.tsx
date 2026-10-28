import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Link } from '@tanstack/react-router'
import { ArrowLeft, Bot, Check, FileDown, Loader2, MessageSquarePlus, Minus, PanelRightClose, PanelRightOpen, Plus } from 'lucide-react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { toast } from 'sonner'
import { diffResume, type ResumeContent, resumeLines, setLine, type ThemeOptions } from '@sidedoor/shared/resume'
import { renderResume, THEMES } from '@sidedoor/shared/resume-themes'
import type { MatchLevel } from '@sidedoor/shared/match'
import { checkTellsWith, STRONG_WEIGHT } from '@sidedoor/shared/tells'
import { MatchList, MatchRing, RecheckButton } from '~/components/app/match'
import { Button } from '~/components/ui/button'
import { Input } from '~/components/ui/input'
import { Switch } from '~/components/ui/switch'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '~/components/ui/tabs'
import { Textarea } from '~/components/ui/textarea'
import { qo, rpc } from '~/lib/api'
import { cn } from '~/lib/utils'
import { byId, FRAME_STYLE, lineHtml } from './frame'
import { Outline } from './outline'
import { ChangesPanel } from './panels'

type Tab = 'content' | 'design' | 'review' | 'notes' | 'match' | 'check'
const PX_PER_IN = 96
const pageSize = (paper: ThemeOptions['paper']) => (paper === 'a4' ? { w: (210 / 25.4) * PX_PER_IN, h: (297 / 25.4) * PX_PER_IN } : { w: 8.5 * PX_PER_IN, h: 11 * PX_PER_IN })
const pref = (k: string, d: string) => (typeof localStorage === 'undefined' ? d : (localStorage.getItem(`sidedoor.resume.${k}`) ?? d))
const setPref = (k: string, v: string) => localStorage.setItem(`sidedoor.resume.${k}`, v)
const clone = <T,>(v: T): T => structuredClone(v)

const ACCENTS = ['#2563eb', '#0f766e', '#7c3aed', '#be123c', '#b45309', '#1f3a5f', '#a8862a', '#111827']

/**
 * The resume designer: a live page with in-place editing, plus panels for structure, design,
 * reviewing your AI's edits, notes, the job match and the writing check. Everything autosaves.
 */
export function ResumeEditor({ resumeId }: { resumeId: string }) {
  const qc = useQueryClient()
  const { data } = useQuery(qo.resume(resumeId))
  const { data: rules } = useQuery(qo.tellRules())
  const frame = useRef<HTMLIFrameElement>(null)
  const stage = useRef<HTMLDivElement>(null)

  const [content, setContent] = useState<ResumeContent | null>(null)
  const [theme, setTheme] = useState('modern')
  const [options, setOptions] = useState<ThemeOptions>({})
  const [renderKey, setRenderKey] = useState(0)
  const [status, setStatus] = useState<'saved' | 'saving' | 'unsaved' | 'conflict'>('saved')
  const version = useRef(0)
  const dirty = useRef(false)
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const [selected, setSelected] = useState<string | null>(null)
  const [spot, setSpot] = useState<string | null>(null)
  const [tab, setTab] = useState<Tab>(() => (pref('tab', 'content') as Tab) || 'content')
  // On a phone the panel covers the page, so start with the page.
  const [panel, setPanel] = useState(() => pref('panel', '1') === '1' && (typeof window === 'undefined' || window.innerWidth >= 768))
  const [fit, setFit] = useState(1)
  const [pages, setPages] = useState(1)
  const [building, setBuilding] = useState(false)

  const resume = data?.resume
  // Adopt the server's copy on first load, and whenever it changes underneath us (an agent edit)
  // while there's nothing unsaved here.
  useEffect(() => {
    if (!resume) return
    if (dirty.current && version.current && resume.version !== version.current) {
      setStatus('conflict')
      return
    }
    if (dirty.current) return
    // The echo of our own save: the page already shows it, and re-rendering would move the cursor.
    if (version.current && resume.version === version.current) {
      // Content is ours, but the design may have changed elsewhere (it doesn't bump the version).
      setTheme(resume.theme)
      setOptions(resume.themeOptions ?? {})
      return
    }
    version.current = resume.version
    setContent(resume.content)
    setTheme(resume.theme)
    setOptions(resume.themeOptions ?? {})
    setRenderKey((k) => k + 1)
  }, [resume])

  const save = useCallback(
    async (next: ResumeContent) => {
      setStatus('saving')
      try {
        const r = await rpc.saveResume({ id: resumeId, content: next as unknown as Record<string, unknown>, baseVersion: version.current })
        if (!r.ok) {
          setStatus('conflict')
          return
        }
        version.current = r.version
        dirty.current = false
        setStatus('saved')
        void qc.invalidateQueries({ queryKey: ['resume', resumeId] })
      } catch (e) {
        setStatus('unsaved')
        toast.error(e instanceof Error ? e.message : 'Save failed')
      }
    },
    [qc, resumeId],
  )

  const schedule = (next: ResumeContent) => {
    dirty.current = true
    setStatus('unsaved')
    clearTimeout(timer.current)
    timer.current = setTimeout(() => void save(next), 700)
  }

  /** Structural edits (outline): re-render the page. */
  const update = (fn: (c: ResumeContent) => void) => {
    setContent((cur) => {
      if (!cur) return cur
      const next = clone(cur)
      fn(next)
      schedule(next)
      return next
    })
    setRenderKey((k) => k + 1)
  }

  /** Typing on the page: keep the cursor, don't re-render. */
  const editFromFrame = (id: string, html: string) => {
    setContent((cur) => {
      if (!cur) return cur
      try {
        const next = setLine(cur, id, html)
        schedule(next)
        return next
      } catch {
        return cur
      }
    })
  }

  useEffect(() => {
    const flush = () => {
      if (dirty.current && content) void save(content)
    }
    window.addEventListener('beforeunload', flush)
    return () => window.removeEventListener('beforeunload', flush)
  }, [content, save])

  const reload = () => {
    dirty.current = false
    version.current = 0
    setStatus('saved')
    void qc.invalidateQueries({ queryKey: ['resume', resumeId] })
  }

  // ------------------------------------------------------------ the page

  const srcDoc = useMemo(
    () => (content ? renderResume(content, theme, options).replace('</head>', `<style id="sd-frame">${FRAME_STYLE}</style></head>`) : null),
    // Re-render only on structural changes; in-place typing updates `content` without it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [renderKey, theme, options],
  )
  const size = pageSize(options.paper)

  const measure = useCallback(() => {
    const doc = frame.current?.contentDocument
    if (!doc?.body) return
    const scale = options.scale ?? 1
    setPages(Math.max(1, Math.ceil((doc.body.scrollHeight * scale - 4) / size.h)))
  }, [options.scale, size.h])

  const onLoad = () => {
    const doc = frame.current?.contentDocument
    if (!doc) return
    doc.documentElement.style.setProperty('--page-h', `${size.h / (options.scale ?? 1)}px`)
    doc.querySelectorAll<HTMLElement>('[data-edit]').forEach((el) => {
      el.contentEditable = 'true'
      el.spellcheck = true
    })
    doc.addEventListener('input', (e) => {
      const el = (e.target as Element).closest?.<HTMLElement>('[data-id]')
      if (el?.dataset.id) editFromFrame(el.dataset.id, lineHtml(el))
      measure()
    })
    doc.addEventListener('paste', (e) => {
      // Plain text only: pasted styles would fight the theme.
      e.preventDefault()
      doc.execCommand('insertText', false, e.clipboardData?.getData('text/plain') ?? '')
    })
    doc.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') e.preventDefault()
    })
    doc.addEventListener('click', (e) => {
      const el = (e.target as Element).closest?.<HTMLElement>('[data-id]')
      setSelected(el?.dataset.id ?? null)
    })
    for (const a of doc.querySelectorAll('a')) a.addEventListener('click', (e) => e.preventDefault())
    void doc.fonts?.ready.then(measure)
    measure()
    decorate()
  }

  // Fit the page to the stage width.
  useEffect(() => {
    const el = stage.current
    if (!el) return
    const ro = new ResizeObserver(() => setFit(Math.min(1.25, (el.clientWidth - 48) / size.w)))
    ro.observe(el)
    return () => ro.disconnect()
  }, [size.w, panel])

  // ------------------------------------------------------------ derived

  const changes = useMemo(() => (content && resume ? diffResume(resume.reviewBase, content) : []), [content, resume])
  const lineList = useMemo(() => (content ? resumeLines(content) : []), [content])
  const lineText = useMemo(() => new Map(lineList.map((l) => [l.id, l.text])), [lineList])
  const notes = resume?.notes ?? []
  const match = data?.match ?? null
  const tells = useMemo(() => {
    if (!rules) return []
    return lineList
      .filter((l) => l.kind !== 'heading' && l.text.length > 3)
      .flatMap((l) => checkTellsWith(rules, l.text).hits.map((h) => ({ ...h, lineId: l.id, lineText: l.text })))
      .sort((a, b) => b.weight - a.weight)
  }, [rules, lineList])

  // Paint pending changes, notes, match levels, the spotlight and the selection onto the page.
  const decorate = useCallback(() => {
    const doc = frame.current?.contentDocument
    if (!doc) return
    const pending = new Set(changes.filter((c) => c.kind !== 'removed').map((c) => c.id))
    const noted = new Set(notes.filter((n) => n.status !== 'resolved' && n.target).map((n) => n.target!))
    const levels = new Map<string, MatchLevel>()
    if (tab === 'match' && match?.match)
      for (const r of match.match.requirements) for (const e of r.evidence) if (!levels.has(e.lineId) || r.level === 'strong') levels.set(e.lineId, r.level)
    doc.querySelectorAll<HTMLElement>('[data-id]').forEach((el) => {
      const id = el.dataset.id!
      el.classList.toggle('sd-pending', pending.has(id))
      el.classList.toggle('sd-note', noted.has(id))
      el.classList.toggle('sd-spot', spot === id)
      el.classList.toggle('sd-selected', selected === id)
      for (const l of ['strong', 'partial', 'weak'] as const) el.classList.toggle(`sd-match-${l}`, levels.get(id) === l)
    })
  }, [changes, notes, spot, selected, tab, match])
  useEffect(decorate, [decorate])

  const focusLine = (id: string) => {
    const el = byId(frame.current?.contentDocument, id)
    if (!el) return
    el.scrollIntoView({ block: 'center', behavior: 'smooth' })
    el.classList.remove('sd-flash')
    void el.offsetWidth
    el.classList.add('sd-flash')
    setSelected(id)
  }

  // ------------------------------------------------------------ actions

  const setDesign = (t: string, o: ThemeOptions) => {
    setTheme(t)
    setOptions(o)
    void rpc.setResumeTheme({ id: resumeId, theme: t, options: o }).then(() => qc.invalidateQueries({ queryKey: ['resume', resumeId] }))
  }

  const fitTo = (n: number) => {
    const doc = frame.current?.contentDocument
    if (!doc?.body) return
    const cur = options.scale ?? 1
    const natural = doc.body.scrollHeight
    const target = Math.max(0.8, Math.min(1.1, Math.floor(((n * size.h - 8) / natural) * 100) / 100))
    if (Math.abs(target - cur) < 0.005) return
    setDesign(theme, { ...options, scale: target })
  }

  const buildPdf = async () => {
    if (dirty.current && content) await save(content)
    setBuilding(true)
    try {
      const r = await rpc.buildResumePdf({ id: resumeId })
      void qc.invalidateQueries({ queryKey: ['resume', resumeId] })
      toast.success(`PDF ready · ${r.pages} page${r.pages === 1 ? '' : 's'}`, {
        action: { label: 'Open', onClick: () => window.open(`/files/${r.file.split('/').map(encodeURIComponent).join('/')}`, '_blank') },
      })
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Could not build the PDF')
    } finally {
      setBuilding(false)
    }
  }

  const review = async (action: 'keep' | 'undo' | 'keep-all' | 'undo-all', ids?: string[]) => {
    if (dirty.current && content) await save(content)
    if (ids && ids.length === 1) await rpc.resumeReview({ id: resumeId, action, lineId: ids[0] })
    else await rpc.resumeReview({ id: resumeId, action: action === 'keep' ? 'keep-all' : action === 'undo' ? 'undo-all' : action })
    reload()
  }

  const openTab = (t: Tab) => {
    setTab(t)
    setPref('tab', t)
    if (!panel) {
      setPanel(true)
      setPref('panel', '1')
    }
  }

  // New agent changes arriving: show them.
  const seen = useRef(0)
  useEffect(() => {
    if (changes.length > seen.current && seen.current >= 0 && resume && version.current) openTab('review')
    seen.current = changes.length
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [changes.length])

  if (!content || !resume) return <div className="flex h-full items-center justify-center text-muted-foreground"><Loader2 className="animate-spin" /></div>

  const scale = fit
  const openNotes = notes.filter((n) => n.status === 'open' || n.status === 'answered').length

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex flex-wrap items-center gap-2 border-b px-3 py-2">
        <Button asChild variant="ghost" size="icon" aria-label="All resumes">
          <Link to="/resume">
            <ArrowLeft />
          </Link>
        </Button>
        <TitleField resumeId={resumeId} title={resume.title} />
        {resume.kind === 'tailored' && resume.applicationId && (
          <Button asChild variant="ghost" size="sm" className="text-muted-foreground">
            <Link to="/applications/$id" params={{ id: resume.applicationId }}>
              For this application
            </Link>
          </Button>
        )}
        <div className="flex-1" />
        <span className={cn('text-xs tabular-nums', status === 'conflict' ? 'text-destructive' : 'text-muted-foreground')}>
          {status === 'saving' ? 'Saving…' : status === 'unsaved' ? 'Unsaved' : status === 'conflict' ? 'Changed elsewhere' : 'Saved'}
        </span>
        {status === 'conflict' && (
          <Button size="sm" variant="outline" onClick={reload}>
            Load latest
          </Button>
        )}
        <span className={cn('rounded-md px-2 py-1 text-xs tabular-nums', pages > 2 ? 'bg-destructive/10 text-destructive' : 'bg-muted text-muted-foreground')} title="Estimated from the preview">
          {pages} page{pages === 1 ? '' : 's'}
        </span>
        <Button size="sm" variant="outline" onClick={buildPdf} disabled={building}>
          {building ? <Loader2 className="animate-spin" /> : <FileDown />} PDF
        </Button>
        <Button
          variant="ghost"
          size="icon"
          onClick={() => {
            setPanel(!panel)
            setPref('panel', panel ? '0' : '1')
          }}
          aria-label={panel ? 'Hide panel' : 'Show panel'}
        >
          {panel ? <PanelRightClose /> : <PanelRightOpen />}
        </Button>
      </div>

      <div className="relative flex min-h-0 flex-1">
        <div ref={stage} className="relative min-w-0 flex-1 overflow-auto bg-muted/50">
          <div className="mx-auto py-6" style={{ width: size.w * scale }}>
            <div style={{ width: size.w, height: Math.max(size.h, pages * size.h) * (options.scale ?? 1), transform: `scale(${scale})`, transformOrigin: 'top left' }}>
              {srcDoc && <iframe key={renderKey} ref={frame} title="Resume preview" srcDoc={srcDoc} onLoad={onLoad} sandbox="allow-same-origin" className="size-full border-0" />}
            </div>
          </div>
          {selected && <LineBar onDone={() => setSelected(null)} onNote={() => openTab('notes')} />}
        </div>

        {panel && (
          <aside className="flex w-[26rem] shrink-0 flex-col border-l bg-background max-lg:w-80 max-md:absolute max-md:inset-y-0 max-md:right-0 max-md:z-20 max-md:w-full max-md:shadow-xl">
            <Tabs value={tab} onValueChange={(v) => openTab(v as Tab)} className="flex min-h-0 flex-1 flex-col gap-0">
              <TabsList className="mx-2 mt-2 flex h-9 w-auto justify-start gap-0.5 overflow-x-auto scrollbar-none [&>button]:flex-none [&>button]:px-2 [&>button]:text-[13px]">
                <TabsTrigger value="content">Content</TabsTrigger>
                <TabsTrigger value="design">Design</TabsTrigger>
                <TabsTrigger value="review">
                  Review{changes.length > 0 && <Badge n={changes.length} />}
                </TabsTrigger>
                <TabsTrigger value="notes">
                  Notes{openNotes > 0 && <Badge n={openNotes} />}
                </TabsTrigger>
                <TabsTrigger value="match" disabled={!match}>
                  Match
                </TabsTrigger>
                <TabsTrigger value="check">
                  Check{tells.filter((t) => t.weight >= STRONG_WEIGHT).length > 0 && <Badge n={tells.filter((t) => t.weight >= STRONG_WEIGHT).length} />}
                </TabsTrigger>
              </TabsList>
              <div className="min-h-0 flex-1 overflow-y-auto">
                <TabsContent value="content">
                  <Outline content={content} update={update} onFocusLine={focusLine} />
                </TabsContent>
                <TabsContent value="design">
                  <DesignPanel theme={theme} options={options} onChange={setDesign} pages={pages} onFit={fitTo} />
                </TabsContent>
                <TabsContent value="review">
                  <ChangesPanel changes={changes} onKeep={(ids) => void review('keep', ids)} onUndo={(ids) => void review('undo', ids)} onSpot={setSpot} onFocus={focusLine} />
                </TabsContent>
                <TabsContent value="notes">
                  <NotesPanel resumeId={resumeId} notes={notes} lineText={lineText} selected={selected} onFocus={focusLine} onSpot={setSpot} />
                </TabsContent>
                <TabsContent value="match">
                  {match?.match && (
                    <div className="space-y-3 p-3">
                      <div className="flex items-center gap-3">
                        <MatchRing score={match.match.score} size={52} />
                        <div className="min-w-0 flex-1 text-sm">
                          <div className="font-medium">
                            {match.companyName} – {match.role}
                          </div>
                          <p className="text-xs text-muted-foreground">{match.match.summary}</p>
                        </div>
                      </div>
                      <RecheckButton stale={match.stale} running={match.running} onRecheck={() => void rpc.startTask({ kind: 'match', applicationId: match.applicationId })} />
                      <MatchList match={match.match} compact liveText={lineText} onSpot={(id: string | null) => setSpot(id)} onFocus={focusLine} />
                    </div>
                  )}
                </TabsContent>
                <TabsContent value="check">
                  <div className="space-y-2 p-3">
                    <p className="text-xs text-muted-foreground">Phrases that make writing read as AI-generated, from your writing check rules. Fix the strong ones.</p>
                    {tells.length === 0 && <p className="py-8 text-center text-sm text-muted-foreground">Nothing flagged.</p>}
                    {tells.map((t, i) => (
                      <button
                        type="button"
                        key={i}
                        className="block w-full rounded-lg border p-2.5 text-left text-sm transition-colors hover:border-foreground/30"
                        onClick={() => focusLine(t.lineId)}
                        onMouseEnter={() => setSpot(t.lineId)}
                        onMouseLeave={() => setSpot(null)}
                      >
                        <div className="flex items-center gap-2">
                          <span className={cn('size-1.5 rounded-full', t.weight >= STRONG_WEIGHT ? 'bg-destructive' : 'bg-muted-foreground/50')} />
                          <span className="font-medium">{t.label}</span>
                          <span className="ml-auto font-mono text-xs text-muted-foreground">“{t.match}”</span>
                        </div>
                        <p className="mt-1 line-clamp-2 text-xs text-muted-foreground">{t.lineText}</p>
                        {t.fix && <p className="mt-1 text-xs">{t.fix}</p>}
                      </button>
                    ))}
                  </div>
                </TabsContent>
              </div>
            </Tabs>
          </aside>
        )}
      </div>
    </div>
  )
}

function Badge({ n }: { n: number }) {
  return <span className="ml-1.5 rounded-full bg-primary/15 px-1.5 text-[11px] leading-4 font-semibold text-primary tabular-nums">{n}</span>
}

function TitleField({ resumeId, title }: { resumeId: string; title: string }) {
  const [v, setV] = useState(title)
  useEffect(() => setV(title), [title])
  return (
    <Input
      value={v}
      onChange={(e) => setV(e.target.value)}
      onBlur={() => v.trim() && v !== title && void rpc.renameResume({ id: resumeId, title: v.trim() })}
      onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()}
      className="h-8 w-64 border-transparent bg-transparent px-2 font-medium shadow-none hover:border-input focus-visible:border-input"
      aria-label="Resume name"
    />
  )
}

/** Quick actions for the line selected on the page. */
function LineBar({ onDone, onNote }: { onDone: () => void; onNote: () => void }) {
  return (
    <div className="pointer-events-none sticky bottom-4 flex justify-center">
      <div className="pointer-events-auto flex items-center gap-1 rounded-full border bg-popover p-1 shadow-lg">
        <Button size="sm" variant="ghost" className="rounded-full" onClick={onNote}>
          <MessageSquarePlus /> Note on this line
        </Button>
        <Button size="sm" variant="ghost" className="rounded-full" onClick={onDone} aria-label="Done">
          <Check />
        </Button>
      </div>
    </div>
  )
}

function DesignPanel({ theme, options, onChange, pages, onFit }: { theme: string; options: ThemeOptions; onChange: (t: string, o: ThemeOptions) => void; pages: number; onFit: (n: number) => void }) {
  const t = THEMES.find((x) => x.id === theme) ?? THEMES[0]!
  const accent = options.accent ?? t.accent
  const scale = options.scale ?? 1
  return (
    <div className="space-y-6 p-4">
      <section className="space-y-2">
        <h3 className="text-xs font-semibold tracking-wide text-muted-foreground uppercase">Template</h3>
        <div className="grid grid-cols-2 gap-2">
          {THEMES.map((x) => (
            <button
              type="button"
              key={x.id}
              onClick={() => onChange(x.id, { ...options, accent: undefined })}
              className={cn('rounded-lg border p-3 text-left transition-colors hover:border-foreground/30', x.id === theme && 'border-primary ring-1 ring-primary')}
            >
              <div className="mb-2 flex items-center gap-1.5">
                <span className="size-3 rounded-full" style={{ background: x.accent }} />
                <span className="text-sm font-medium">{x.name}</span>
              </div>
              <p className="text-xs leading-snug text-muted-foreground">{x.description}</p>
            </button>
          ))}
        </div>
      </section>
      <section className="space-y-2">
        <h3 className="text-xs font-semibold tracking-wide text-muted-foreground uppercase">Accent</h3>
        <div className="flex flex-wrap items-center gap-2">
          {[t.accent, ...ACCENTS.filter((a) => a !== t.accent)].map((a) => (
            <button
              type="button"
              key={a}
              onClick={() => onChange(theme, { ...options, accent: a })}
              className={cn('size-7 rounded-full border-2 border-transparent', a.toLowerCase() === accent.toLowerCase() && 'border-foreground')}
              style={{ background: a }}
              aria-label={`Accent ${a}`}
            />
          ))}
          <input type="color" value={accent} onChange={(e) => onChange(theme, { ...options, accent: e.target.value })} className="size-7 cursor-pointer rounded-full border bg-transparent" aria-label="Custom accent" />
        </div>
      </section>
      <section className="space-y-3">
        <h3 className="text-xs font-semibold tracking-wide text-muted-foreground uppercase">Page</h3>
        <div className="flex gap-2">
          {(['letter', 'a4'] as const).map((p) => (
            <Button key={p} size="sm" variant={(options.paper ?? 'letter') === p ? 'default' : 'outline'} onClick={() => onChange(theme, { ...options, paper: p })}>
              {p === 'letter' ? 'US Letter' : 'A4'}
            </Button>
          ))}
        </div>
        <div className="space-y-1.5">
          <div className="flex items-center justify-between text-sm">
            <span>Text size</span>
            <span className="text-xs text-muted-foreground tabular-nums">{Math.round(scale * 100)}%</span>
          </div>
          <div className="flex items-center gap-2">
            <Button size="icon" variant="outline" className="size-7" onClick={() => onChange(theme, { ...options, scale: Math.max(0.8, Math.round((scale - 0.02) * 100) / 100) })} aria-label="Smaller">
              <Minus />
            </Button>
            <input type="range" min={80} max={115} value={Math.round(scale * 100)} onChange={(e) => onChange(theme, { ...options, scale: Number(e.target.value) / 100 })} className="flex-1 accent-[var(--primary)]" />
            <Button size="icon" variant="outline" className="size-7" onClick={() => onChange(theme, { ...options, scale: Math.min(1.15, Math.round((scale + 0.02) * 100) / 100) })} aria-label="Larger">
              <Plus />
            </Button>
          </div>
          <div className="flex gap-2 pt-1">
            <Button size="sm" variant="outline" onClick={() => onFit(1)}>
              Fit to 1 page
            </Button>
            <Button size="sm" variant="outline" onClick={() => onFit(2)} disabled={pages <= 2 && scale >= 1}>
              Fit to 2 pages
            </Button>
          </div>
        </div>
        <label className="flex items-center justify-between text-sm">
          Show highlights row
          <Switch checked={options.showHighlights ?? true} onCheckedChange={(v) => onChange(theme, { ...options, showHighlights: v })} />
        </label>
      </section>
    </div>
  )
}

function NotesPanel({ resumeId, notes, lineText, selected, onFocus, onSpot }: {
  resumeId: string
  notes: Array<{ id: string; target: string | null; quote: string; status: string; thread: Array<{ who: string; text: string; at: string }> }>
  lineText: Map<string, string>
  selected: string | null
  onFocus: (id: string) => void
  onSpot: (id: string | null) => void
}) {
  const qc = useQueryClient()
  const [text, setText] = useState('')
  const [asking, setAsking] = useState(false)
  const refresh = () => qc.invalidateQueries({ queryKey: ['resume', resumeId] })
  const add = async () => {
    if (!text.trim()) return
    await rpc.resumeNote({ id: resumeId, action: 'add', target: selected, text: text.trim() })
    setText('')
    void refresh()
  }
  const open = notes.filter((n) => n.status !== 'resolved')
  return (
    <div className="space-y-3 p-3">
      <div className="space-y-2 rounded-lg border p-2.5">
        <p className="text-xs text-muted-foreground">
          {selected ? (
            <>
              Note on: <span className="text-foreground">{(lineText.get(selected) ?? '').slice(0, 80)}</span>
            </>
          ) : (
            'Note on the whole resume. Click a line on the page to attach a note to it.'
          )}
        </p>
        <Textarea value={text} onChange={(e) => setText(e.target.value)} placeholder="e.g. Make this bullet about the outcome, not the tools" className="min-h-16 text-sm" />
        <div className="flex gap-2">
          <Button size="sm" onClick={add} disabled={!text.trim()}>
            Add note
          </Button>
          <Button
            size="sm"
            variant="outline"
            disabled={asking || !notes.some((n) => n.status === 'open')}
            onClick={async () => {
              setAsking(true)
              try {
                await rpc.askAiAboutNotes({ id: resumeId })
                toast.success('Your AI is working on your notes. Its edits will show up under Review.')
              } finally {
                setAsking(false)
              }
            }}
          >
            {asking ? <Loader2 className="animate-spin" /> : <Bot />} Ask your AI
          </Button>
        </div>
      </div>
      {open.length === 0 && <p className="py-6 text-center text-sm text-muted-foreground">No open notes.</p>}
      {open.map((n) => (
        <div key={n.id} className="rounded-lg border p-2.5 text-sm" onMouseEnter={() => n.target && onSpot(n.target)} onMouseLeave={() => onSpot(null)}>
          {n.target && (
            <button type="button" className="mb-1.5 line-clamp-2 text-left text-xs text-muted-foreground hover:text-foreground" onClick={() => onFocus(n.target!)}>
              {lineText.get(n.target) ?? '(line removed)'}
            </button>
          )}
          {n.thread.map((m, i) => (
            <p key={i} className={cn('mt-1 whitespace-pre-wrap', m.who !== 'user' && 'rounded-md bg-muted px-2 py-1.5')}>
              {m.who !== 'user' && <span className="mr-1 text-xs font-medium text-muted-foreground">AI</span>}
              {m.text}
            </p>
          ))}
          <div className="mt-2 flex gap-1">
            <Button size="sm" variant="ghost" onClick={() => void rpc.resumeNote({ id: resumeId, action: 'status', noteId: n.id, status: 'resolved' }).then(refresh)}>
              Resolve
            </Button>
            <span className="ml-auto self-center text-[11px] text-muted-foreground">{n.status === 'answered' ? 'Answered' : 'Open'}</span>
          </div>
        </div>
      ))}
    </div>
  )
}

