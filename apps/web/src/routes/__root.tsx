import type { QueryClient } from '@tanstack/react-query'
import { createRootRouteWithContext, Outlet, redirect, useRouterState } from '@tanstack/react-router'
import { ChatProvider } from '~/components/app/chat'
import { AppShell } from '~/components/app/shell'
import { Toaster } from '~/components/ui/sonner'
import { TooltipProvider } from '~/components/ui/tooltip'
import { qo } from '~/lib/api'
import { RpcError } from '~/lib/rpc'
import { ThemeSync } from '~/lib/theme'

/** Pages that render without the app shell. */
const BARE = ['/pair', '/welcome']

export const Route = createRootRouteWithContext<{ queryClient: QueryClient }>()({
  beforeLoad: async ({ location, context }) => {
    if (location.pathname === '/pair') return
    // Signed in? (The desktop app sets the session cookie itself; browsers pair once.)
    const s = await context.queryClient.ensureQueryData(qo.settings()).catch((e: unknown) => {
      if (e instanceof RpcError && e.status === 401) throw redirect({ to: '/pair' })
      throw e
    })
    // New installs go through onboarding first.
    if (!s.settings.onboarding.completedAt && location.pathname !== '/welcome') throw redirect({ to: '/welcome' })
  },
  component: Root,
  notFoundComponent: () => <div className="py-20 text-center text-muted-foreground">Not found.</div>,
})

function Root() {
  const bare = useRouterState({ select: (s) => BARE.some((p) => s.location.pathname.startsWith(p)) })
  return (
    <TooltipProvider delayDuration={300}>
      <ThemeSync />
      <ChatProvider>{bare ? <Outlet /> : <AppShell><Outlet /></AppShell>}</ChatProvider>
      <Toaster position="top-center" />
    </TooltipProvider>
  )
}
