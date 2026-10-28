import { useQuery } from '@tanstack/react-query'
import { useEffect } from 'react'
import { qo } from './api'

export type ThemePref = 'system' | 'light' | 'dark'

const media = () => window.matchMedia('(prefers-color-scheme: dark)')

export const applyTheme = (pref: ThemePref) => {
  const dark = pref === 'dark' || (pref === 'system' && media().matches)
  document.documentElement.classList.toggle('dark', dark)
  try {
    localStorage.setItem('sidedoor-theme', pref)
  } catch {
    // private mode
  }
}

/** Follow Settings → Appearance (and the OS, for "system"). index.html applies it before first paint. */
export function ThemeSync() {
  const onPair = typeof window !== 'undefined' && window.location.pathname.startsWith('/pair')
  const { data } = useQuery({ ...qo.settings(), retry: false, enabled: !onPair })
  const pref = (data?.settings.app.theme ?? 'system') as ThemePref
  useEffect(() => {
    applyTheme(pref)
    if (pref !== 'system') return
    const m = media()
    const on = () => applyTheme('system')
    m.addEventListener('change', on)
    return () => m.removeEventListener('change', on)
  }, [pref])
  return null
}
