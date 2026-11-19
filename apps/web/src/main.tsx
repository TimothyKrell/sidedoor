import { focusManager, QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { createRouter, RouterProvider } from '@tanstack/react-router'
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { routeTree } from './routeTree.gen'
import './styles.css'

// A window you've switched away from is in the background, even while it's still on screen (a
// covered window never reports itself hidden on Linux). There polling stops and spinners hold still,
// so an idle Sidedoor costs next to nothing; the live change stream keeps it current, and coming back
// refetches whatever went stale.
focusManager.setEventListener((setFocused) => {
  const update = () => {
    const focused = document.visibilityState === 'visible' && document.hasFocus()
    document.documentElement.toggleAttribute('data-background', !focused)
    setFocused(focused)
  }
  update()
  window.addEventListener('focus', update)
  window.addEventListener('blur', update)
  document.addEventListener('visibilitychange', update)
  return () => {
    window.removeEventListener('focus', update)
    window.removeEventListener('blur', update)
    document.removeEventListener('visibilitychange', update)
  }
})

const queryClient = new QueryClient({
  defaultOptions: { queries: { staleTime: 5_000, refetchOnWindowFocus: true, retry: 1 } },
})

const router = createRouter({
  routeTree,
  context: { queryClient },
  scrollRestoration: true,
  defaultPreload: 'intent',
  defaultPreloadStaleTime: 0,
})

declare module '@tanstack/react-router' {
  interface Register {
    router: typeof router
  }
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>
  </StrictMode>,
)
