import { app, BrowserWindow, ipcMain } from 'electron'
import { autoUpdater } from 'electron-updater'

/**
 * Updates from GitHub Releases (electron-updater). Nothing downloads without the user: we check
 * shortly after start and every few hours, show "available" in Settings → About, and install on
 * "Restart and update". Off in dev, and for Linux installs not made from our AppImage.
 */
export type UpdateState =
  | { state: 'idle' | 'checking' | 'none' | 'disabled' }
  | { state: 'available'; version: string }
  | { state: 'downloading'; percent: number }
  | { state: 'ready'; version: string }
  | { state: 'error'; message: string }

export const setupUpdater = (o: { beforeInstall: () => Promise<void> }) => {

  const enabled = app.isPackaged && !process.env.SIDEDOOR_DISABLE_AUTO_UPDATE && (process.platform !== 'linux' || !!process.env.APPIMAGE)
  let state: UpdateState = enabled ? { state: 'idle' } : { state: 'disabled' }
  const set = (s: UpdateState) => {
    state = s
    for (const w of BrowserWindow.getAllWindows()) w.webContents.send('sidedoor:update:state', s)
  }
  ipcMain.handle('sidedoor:update:get', () => state)
  ipcMain.handle('sidedoor:update:check', () => enabled && autoUpdater.checkForUpdates().catch((e: unknown) => set({ state: 'error', message: String(e) })))
  ipcMain.handle('sidedoor:update:download', () => enabled && autoUpdater.downloadUpdate().catch((e: unknown) => set({ state: 'error', message: String(e) })))
  ipcMain.handle('sidedoor:update:install', async () => {
    if (state.state !== 'ready') return
    await o.beforeInstall()
    autoUpdater.quitAndInstall()
  })
  if (!enabled) return
  autoUpdater.autoDownload = false
  autoUpdater.autoInstallOnAppQuit = true
  autoUpdater.on('checking-for-update', () => set({ state: 'checking' }))
  autoUpdater.on('update-available', (i) => set({ state: 'available', version: i.version }))
  autoUpdater.on('update-not-available', () => set({ state: 'none' }))
  autoUpdater.on('download-progress', (p) => set({ state: 'downloading', percent: p.percent }))
  autoUpdater.on('update-downloaded', (i) => set({ state: 'ready', version: i.version }))
  autoUpdater.on('error', (e) => set({ state: 'error', message: e.message }))
  setTimeout(() => void autoUpdater.checkForUpdates().catch(() => {}), 20_000)
  setInterval(() => void autoUpdater.checkForUpdates().catch(() => {}), 4 * 3600_000).unref()
}
