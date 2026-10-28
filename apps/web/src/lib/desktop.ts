/**
 * What the desktop app adds (apps/desktop/src/preload.ts). Undefined in a plain browser; every
 * caller handles that, so the same UI works on desktop, in a browser and on a phone.
 */
export type UpdateState =
  | { state: 'idle' | 'checking' | 'none' | 'disabled' }
  | { state: 'available'; version: string }
  | { state: 'downloading'; percent: number }
  | { state: 'ready'; version: string }
  | { state: 'error'; message: string }

export interface DesktopBridge {
  platform: 'darwin' | 'win32' | 'linux'
  version: string
  setLaunchAtLogin: (on: boolean) => Promise<void>
  openExternal: (url: string) => Promise<void>
  openPath: (path: string) => Promise<void>
  update: {
    get: () => Promise<UpdateState>
    check: () => Promise<void>
    download: () => Promise<void>
    install: () => Promise<void>
    onChange: (fn: (s: UpdateState) => void) => () => void
  }
  /** Tray items and notification clicks ask the app to open a page. */
  onNavigate: (fn: (path: string) => void) => () => void
}

export const desktop: DesktopBridge | undefined = typeof window !== 'undefined' ? (window as unknown as { sidedoorDesktop?: DesktopBridge }).sidedoorDesktop : undefined
