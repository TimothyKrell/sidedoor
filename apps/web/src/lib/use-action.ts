import { useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import { toast } from 'sonner'

/**
 * Wrap a server function call: shows errors as toasts and refreshes every query afterwards
 * (the app is local and small, so blanket invalidation is cheap and always correct).
 */
export function useAction<A, R>(fn: (args: A) => Promise<R>, opts: { success?: string | ((r: R) => string) } = {}) {
  const qc = useQueryClient()
  const [pending, setPending] = useState(false)
  const run = async (args: A): Promise<R | undefined> => {
    setPending(true)
    try {
      const r = await fn(args)
      if (opts.success) toast.success(typeof opts.success === 'function' ? opts.success(r) : opts.success)
      await qc.invalidateQueries()
      return r
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e))
      return undefined
    } finally {
      setPending(false)
    }
  }
  return { run, pending }
}
