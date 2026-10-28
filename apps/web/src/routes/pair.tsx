import { createFileRoute, useNavigate } from '@tanstack/react-router'
import { DoorOpen, Loader2 } from 'lucide-react'
import { useEffect, useState } from 'react'

export const Route = createFileRoute('/pair')({ component: Pair })

/**
 * A browser or phone signs in with a pairing link (`/pair#token=…`) from the desktop app's
 * Settings → Phone & other devices, or from `sidedoor pair`. The token is in the URL hash, so it
 * never reaches server logs; it's exchanged once for a session cookie.
 */
function Pair() {
  const nav = useNavigate()
  const [state, setState] = useState<'idle' | 'working' | 'error'>('idle')
  const [error, setError] = useState('')
  useEffect(() => {
    const token = new URLSearchParams(window.location.hash.slice(1)).get('token')
    if (!token) return
    setState('working')
    history.replaceState(null, '', '/pair')
    void fetch('/api/auth/pair', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ token }) })
      .then(async (r) => {
        if (!r.ok) throw new Error(((await r.json()) as { error?: string }).error ?? 'Pairing failed')
        window.location.replace('/')
      })
      .catch((e: unknown) => {
        setState('error')
        setError(e instanceof Error ? e.message : String(e))
      })
  }, [nav])
  return (
    <div className="flex min-h-dvh items-center justify-center p-6">
      <div className="w-full max-w-sm space-y-4 text-center">
        <DoorOpen className="mx-auto size-10 text-primary" />
        <h1 className="text-xl font-semibold">Connect to Sidedoor</h1>
        {state === 'working' ? (
          <p className="flex items-center justify-center gap-2 text-sm text-muted-foreground">
            <Loader2 className="size-4 animate-spin" /> Signing in…
          </p>
        ) : (
          <>
            {state === 'error' && <p className="text-sm text-destructive">{error}</p>}
            <p className="text-sm leading-relaxed text-muted-foreground">
              Open Sidedoor on your computer, go to <span className="text-foreground">Settings → Phone & other devices</span>, and open the link (or scan the code) shown there. Running Sidedoor from a terminal? Run <code className="rounded bg-muted px-1 py-0.5 text-xs">sidedoor pair</code>.
            </p>
          </>
        )}
      </div>
    </div>
  )
}
