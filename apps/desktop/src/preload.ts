import { contextBridge, ipcRenderer } from 'electron'

/** What the web app can ask of the desktop app (apps/web/src/lib/desktop.ts). */
contextBridge.exposeInMainWorld('sidedoorDesktop', {
  platform: process.platform,
  version: ipcRenderer.sendSync('sidedoor:version') as string,
  setLaunchAtLogin: (on: boolean) => ipcRenderer.invoke('sidedoor:launch-at-login', on),
  openExternal: (url: string) => ipcRenderer.invoke('sidedoor:open-external', url),
  openPath: (path: string) => ipcRenderer.invoke('sidedoor:open-path', path),
  update: {
    get: () => ipcRenderer.invoke('sidedoor:update:get'),
    check: () => ipcRenderer.invoke('sidedoor:update:check'),
    download: () => ipcRenderer.invoke('sidedoor:update:download'),
    install: () => ipcRenderer.invoke('sidedoor:update:install'),
    onChange: (fn: (s: unknown) => void) => {
      const h = (_e: unknown, s: unknown) => fn(s)
      ipcRenderer.on('sidedoor:update:state', h)
      return () => ipcRenderer.off('sidedoor:update:state', h)
    },
  },
  onNavigate: (fn: (path: string) => void) => {
    const h = (_e: unknown, p: string) => fn(p)
    ipcRenderer.on('sidedoor:navigate', h)
    return () => ipcRenderer.off('sidedoor:navigate', h)
  },
})
