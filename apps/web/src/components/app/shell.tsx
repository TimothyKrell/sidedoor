import { useQuery } from '@tanstack/react-query'
import { Link, useNavigate, useRouterState } from '@tanstack/react-router'
import {
  BookOpen,
  Bot,
  Briefcase,
  DoorOpen,
  FileText,
  KanbanSquare,
  ListTodo,
  Menu,
  type LucideIcon,
  MessageSquare,
  Radar,
  Rss,
  Search,
  Settings,
  Sun,
  UserRound,
  Users,
  X,
} from 'lucide-react'
import { type ReactNode, useEffect, useState } from 'react'
import { Button } from '~/components/ui/button'
import { CommandDialog, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from '~/components/ui/command'
import { Sheet, SheetContent, SheetHeader, SheetTitle } from '~/components/ui/sheet'
import { qo, searchFn } from '~/lib/api'
import { desktop } from '~/lib/desktop'
import { onNotice, useLiveUpdates } from '~/lib/live'
import { toast } from 'sonner'
import { useMediaQuery } from '~/lib/use-media-query'
import { cn } from '~/lib/utils'
import { ChatView, ThreadPicker, useChat } from './chat'
import { CompanyAvatar, Due, FitBadge, StageBadge, TimeAgo } from './bits'

interface NavItem {
  to: string
  label: string
  icon: LucideIcon
  mobile?: boolean
}

const NAV: NavItem[] = [
  { to: '/', label: 'Today', icon: Sun, mobile: true },
  { to: '/jobs', label: 'Jobs', icon: Briefcase, mobile: true },
  { to: '/pipeline', label: 'Pipeline', icon: KanbanSquare, mobile: true },
  { to: '/people', label: 'People', icon: Users, mobile: true },
  { to: '/resume', label: 'Resume', icon: FileText },
  { to: '/profile', label: 'Profile', icon: UserRound },
  { to: '/stories', label: 'Story bank', icon: BookOpen },
  { to: '/chat', label: 'Chat', icon: MessageSquare },
  { to: '/radar', label: 'Funding radar', icon: Radar },
  { to: '/tasks', label: 'AI tasks', icon: ListTodo },
  { to: '/sources', label: 'Job sources', icon: Rss },
  { to: '/settings', label: 'Settings', icon: Settings },
]

const isActive = (path: string, to: string) => (to === '/' ? path === '/' : path === to || path.startsWith(`${to}/`) || (to === '/pipeline' && path.startsWith('/applications')))

/** ⌘ on Mac, Ctrl elsewhere (decided after mount to keep SSR markup stable). */
function Shortcut({ k, className }: { k: string; className?: string }) {
  const [mac, setMac] = useState(true)
  useEffect(() => setMac(/Mac|iPhone|iPad/.test(navigator.platform)), [])
  return <kbd className={cn('font-mono text-[11px]', className)}>{mac ? `⌘${k}` : `Ctrl+${k}`}</kbd>
}

function WorkerDot() {
  const { data } = useQuery(qo.status())
  if (!data) return null
  const alive = data.workerAlive
  return (
    <div className="flex items-center gap-2 text-xs text-muted-foreground" title={alive ? 'Worker running' : 'Background work isn’t running. Restart Sidedoor.'}>
      <span className={cn('size-2 rounded-full', alive ? (data.running ? 'animate-pulse bg-primary' : 'bg-success') : 'bg-destructive')} />
      {alive ? (
        <span className="truncate">
          {data.running ? `AI: ${data.running} running${data.queued ? `, ${data.queued} queued` : ''}` : data.pendingTriage ? `Triaging ${data.pendingTriage}` : data.lastScan?.at ? <>Checked <TimeAgo iso={data.lastScan.at} /></> : 'Not checked yet'}
        </span>
      ) : (
        <span>Worker offline</span>
      )}
    </div>
  )
}

/** Running/queued AI tasks beside the nav item: a spinning arc while work is in flight. */
function TaskActivity({ compact = false }: { compact?: boolean }) {
  const { data } = useQuery(qo.status())
  const running = data?.running ?? 0
  const queued = data?.queued ?? 0
  if (!running && !queued) return null
  const label = [running && `${running} running`, queued && `${queued} queued`].filter(Boolean).join(', ')
  if (compact)
    return (
      <span className="absolute top-1.5 right-1.5 flex size-4 items-center justify-center" title={label}>
        <span className={cn('absolute inset-0 rounded-full border-2 border-primary/25', running && 'animate-spin border-t-primary')} />
        <span className="text-[11px] font-semibold text-primary tabular-nums">{running + queued}</span>
      </span>
    )
  return (
    <span className="ml-auto flex items-center gap-1" title={label} aria-label={label}>
      {running > 0 && (
        <span className="flex items-center gap-1 rounded-full bg-primary/12 py-0.5 pr-1.5 pl-1 text-[11px] font-medium text-primary tabular-nums">
          <span className="size-2.5 animate-spin rounded-full border-[1.5px] border-primary/25 border-t-primary" />
          {running}
        </span>
      )}
      {queued > 0 && (
        <span className="rounded-full bg-muted px-1.5 py-0.5 text-[11px] text-muted-foreground tabular-nums">+{queued}</span>
      )}
    </span>
  )
}

function SearchPalette({ open, setOpen }: { open: boolean; setOpen: (o: boolean) => void }) {
  const [q, setQ] = useState('')
  const navigate = useNavigate()
  const { data } = useQuery({ queryKey: ['search', q], queryFn: () => searchFn({ data: { q } }), enabled: q.length > 1 })
  const go = (to: string) => {
    setOpen(false)
    setQ('')
    void navigate({ to })
  }
  return (
    <CommandDialog open={open} onOpenChange={setOpen} title="Search">
      <CommandInput placeholder="Search companies, roles, people…" value={q} onValueChange={setQ} />
      <CommandList>
        <CommandEmpty>{q.length > 1 ? 'Nothing found.' : 'Type to search.'}</CommandEmpty>
        {!!data?.applications.length && (
          <CommandGroup heading="Applications">
            {data.applications.map((a) => (
              <CommandItem key={a.id} value={`app ${a.id} ${a.companyName} ${a.role}`} onSelect={() => go(`/applications/${a.id}`)}>
                <CompanyAvatar name={a.companyName} className={cn('size-7 text-[11px]', a.status.startsWith('closed') && 'opacity-50')} />
                <div className="min-w-0 flex-1">
                  <div className="truncate">
                    {a.companyName} <span className="text-muted-foreground">· {a.role}</span>
                  </div>
                  <div className="flex items-center gap-1.5 truncate text-xs text-muted-foreground">
                    {a.nextAction ? (
                      <>
                        <span className="truncate">{a.nextAction}</span>
                        <Due date={a.nextActionDate} className="text-[11px]" />
                      </>
                    ) : a.appliedAt ? (
                      <>applied <TimeAgo iso={a.appliedAt} /></>
                    ) : (
                      <>active <TimeAgo iso={a.lastActivityAt ?? a.createdAt} /></>
                    )}
                  </div>
                </div>
                <div className="flex shrink-0 items-center gap-1.5">
                  <FitBadge fit={a.fitScore} className="h-5 min-w-6 text-[11px]" />
                  <StageBadge stage={a.stage} />
                </div>
              </CommandItem>
            ))}
          </CommandGroup>
        )}
        {!!data?.people.length && (
          <CommandGroup heading="People">
            {data.people.map((p) => (
              <CommandItem key={p.id} value={`person ${p.id} ${p.name} ${p.companyName ?? ''}`} onSelect={() => go(`/people/${p.id}`)}>
                <Users /> {p.name} <span className="text-muted-foreground">{p.companyName}</span>
              </CommandItem>
            ))}
          </CommandGroup>
        )}
        {!!data?.postings.length && (
          <CommandGroup heading="Postings">
            {data.postings.map((p) => (
              <CommandItem key={p.id} value={`job ${p.id} ${p.companyName ?? ''} ${p.title}`} onSelect={() => go(`/jobs/${p.id}`)}>
                <Briefcase /> {p.companyName} – {p.title}
              </CommandItem>
            ))}
          </CommandGroup>
        )}
        <CommandGroup heading="Go to">
          {NAV.map((n) => (
            <CommandItem key={n.to} value={`nav ${n.label}`} onSelect={() => go(n.to)}>
              <n.icon /> {n.label}
            </CommandItem>
          ))}
        </CommandGroup>
      </CommandList>
    </CommandDialog>
  )
}

export function AppShell({ children }: { children: ReactNode }) {
  const path = useRouterState({ select: (s) => s.location.pathname })
  const chat = useChat()
  const [searchOpen, setSearchOpen] = useState(false)
  const onChatPage = path.startsWith('/chat')
  const fullBleed = path.startsWith('/resume/')
  // The pipeline board has a column per stage, so it takes the whole width instead of the reading column.
  const wide = path === '/pipeline'
  useLiveUpdates()
  const navigate = useNavigate()
  // In a browser, notifications show as toasts (the desktop app shows native ones instead).
  useEffect(() => desktop?.onNavigate((p) => void navigate({ to: p })), [navigate])
  useEffect(() => {
    if (desktop) return
    const off = onNotice((n) => {
      toast(n.title, { description: n.body, ...(n.path ? { action: { label: 'Open', onClick: () => void navigate({ to: n.path! }) } } : {}) })
    })
    return () => void off()
  }, [navigate])
  // Wide screens dock the chat beside the page (nothing covered); narrow screens get a full-screen sheet.
  const docked = useMediaQuery('(min-width: 1024px)')
  // Keep the panel's contents mounted until the slide-out finishes.
  const [panelMounted, setPanelMounted] = useState(false)
  useEffect(() => {
    if (chat.open) return setPanelMounted(true)
    const t = setTimeout(() => setPanelMounted(false), 220)
    return () => clearTimeout(t)
  }, [chat.open])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 'k') {
        e.preventDefault()
        setSearchOpen((o) => !o)
      }
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'i') {
        e.preventDefault()
        chat.setOpen(!chat.open)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [chat])

  return (
    <div className="flex min-h-dvh">
      {/* Desktop sidebar */}
      <aside className="sticky top-0 hidden h-dvh w-60 shrink-0 flex-col border-r bg-sidebar md:flex">
        <Link to="/" className="flex items-center gap-2 px-5 pt-5 pb-4">
          <span className="flex size-8 items-center justify-center rounded-lg bg-primary text-primary-foreground">
            <DoorOpen className="size-4.5" />
          </span>
          <span className="text-base font-semibold tracking-tight">Sidedoor</span>
        </Link>
        <button type="button" onClick={() => setSearchOpen(true)} className="mx-3 mb-3 flex items-center gap-2 rounded-lg border bg-background/40 px-3 py-1.5 text-sm text-muted-foreground hover:text-foreground">
          <Search className="size-3.5" /> Search
          <Shortcut k="K" className="ml-auto" />
        </button>
        <nav className="flex-1 space-y-0.5 overflow-y-auto px-3">
          {NAV.map((n) => (
            <Link
              key={n.to}
              to={n.to}
              className={cn(
                'flex items-center gap-2.5 rounded-lg px-3 py-1.5 text-sm text-sidebar-foreground/80 transition-colors hover:bg-sidebar-accent hover:text-sidebar-accent-foreground',
                isActive(path, n.to) && 'bg-sidebar-accent font-medium text-sidebar-accent-foreground',
              )}
            >
              <n.icon className="size-4" />
              {n.label}
              {n.to === '/tasks' && <TaskActivity />}
            </Link>
          ))}
        </nav>
        <div className="space-y-3 border-t p-4">
          <WorkerDot />
          {!onChatPage && (
            <Button className="w-full justify-start" variant="secondary" onClick={() => chat.setOpen(true)}>
              <Bot /> Ask your AI <Shortcut k="I" className="ml-auto text-muted-foreground" />
            </Button>
          )}
        </div>
      </aside>

      {/* Full-bleed pages get exactly the window's height (less the phone's bottom bar), so they scroll inside themselves. */}
      <div className={cn('flex min-w-0 flex-1 flex-col', fullBleed && 'h-dvh max-md:pb-16')}>
        {/* Mobile top bar */}
        <header className="sticky top-0 z-30 flex items-center gap-2 border-b bg-background/85 px-4 py-2.5 backdrop-blur pt-safe md:hidden">
          <Link to="/" className="flex items-center gap-2">
            <span className="flex size-7 items-center justify-center rounded-md bg-primary text-primary-foreground">
              <DoorOpen className="size-4" />
            </span>
          </Link>
          <div className="min-w-0 flex-1">
            <WorkerDot />
          </div>
          <Button size="icon" variant="ghost" onClick={() => setSearchOpen(true)} aria-label="Search">
            <Search />
          </Button>
          <MobileMore path={path} />
        </header>

        {/* Full-bleed pages (the resume editor) manage their own layout and use the whole width. */}
        <main className={cn('w-full flex-1', fullBleed ? 'min-h-0 min-w-0' : cn('mx-auto px-4 pt-5 pb-28 md:px-8 md:pt-8 md:pb-10', wide ? 'min-w-0' : 'max-w-6xl'))}>{children}</main>
      </div>

      {/* Docked chat panel (desktop): slides in and pushes the page over instead of covering it */}
      {docked && !onChatPage && (
        <aside
          inert={!chat.open}
          className={cn('sticky top-0 h-dvh shrink-0 overflow-hidden border-l bg-background transition-[width] duration-200 ease-out', chat.open ? 'w-[400px] xl:w-[440px]' : 'w-0 border-l-0')}
        >
          <div className="flex h-full w-[400px] flex-col xl:w-[440px]">
            <div className="flex items-center gap-2 border-b px-4 py-3">
              <Bot className="size-4 shrink-0 text-primary" />
              <ThreadPicker className="-ml-1" />
              <Button size="sm" variant="ghost" className="ml-auto h-7 shrink-0 text-xs" onClick={() => chat.setThreadId(null)}>
                New chat
              </Button>
              <Button size="icon" variant="ghost" className="size-7" onClick={() => chat.setOpen(false)} aria-label="Close chat">
                <X />
              </Button>
            </div>
            {panelMounted && <ChatView key={chat.threadId ?? 'new'} threadId={chat.threadId} onThread={chat.setThreadId} className="min-h-0 flex-1" autoFocus />}
          </div>
        </aside>
      )}

      {/* Mobile bottom nav */}
      <nav className="fixed inset-x-0 bottom-0 z-30 grid grid-cols-5 border-t bg-background/90 backdrop-blur pb-safe md:hidden">
        {NAV.filter((n) => n.mobile).map((n) => (
          <Link key={n.to} to={n.to} className={cn('flex flex-col items-center gap-0.5 pt-2 text-[11px] text-muted-foreground', isActive(path, n.to) && 'text-primary')}>
            <n.icon className="size-5" />
            {n.label}
          </Link>
        ))}
        <button type="button" onClick={() => chat.setOpen(true)} className={cn('flex flex-col items-center gap-0.5 pt-2 text-[11px] text-muted-foreground', chat.open && 'text-primary')}>
          <Bot className="size-5" />
          AI
        </button>
      </nav>

      {/* Chat drawer */}
      <Sheet open={chat.open && !docked} onOpenChange={chat.setOpen}>
        <SheetContent side="right" className="flex w-full flex-col gap-0 p-0 sm:max-w-[460px]">
          <SheetHeader className="flex-row items-center gap-2 border-b px-4 py-3">
            <SheetTitle className="sr-only">Chat with your AI</SheetTitle>
            <Bot className="size-4 shrink-0 text-primary" />
            <ThreadPicker className="-ml-1" />
            <Button size="sm" variant="ghost" className="mr-8 ml-auto h-7 shrink-0 text-xs" onClick={() => chat.setThreadId(null)}>
              New chat
            </Button>
          </SheetHeader>
          <ChatView key={chat.threadId ?? 'new'} threadId={chat.threadId} onThread={chat.setThreadId} className="flex-1" autoFocus />
        </SheetContent>
      </Sheet>

      <SearchPalette open={searchOpen} setOpen={setSearchOpen} />
    </div>
  )
}

function MobileMore({ path }: { path: string }) {
  const [open, setOpen] = useState(false)
  useEffect(() => setOpen(false), [path])
  return (
    <Sheet open={open} onOpenChange={setOpen}>
      <Button size="icon" variant="ghost" onClick={() => setOpen(true)} aria-label="More">
        <Menu />
      </Button>
      <SheetContent side="bottom" className="rounded-t-2xl pb-safe">
        <SheetHeader>
          <SheetTitle>Sidedoor</SheetTitle>
        </SheetHeader>
        <div className="grid grid-cols-3 gap-2 px-4 pb-4">
          {NAV.map((n) => (
            <Link key={n.to} to={n.to} className={cn('relative flex flex-col items-center gap-1.5 rounded-xl border bg-card p-3 text-xs', isActive(path, n.to) && 'border-primary text-primary')}>
              <n.icon className="size-5" />
              {n.label}
              {n.to === '/tasks' && <TaskActivity compact />}
            </Link>
          ))}
        </div>
      </SheetContent>
    </Sheet>
  )
}
