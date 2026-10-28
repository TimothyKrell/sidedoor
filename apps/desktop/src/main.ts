import { spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve, sep } from 'node:path'
import { app, BrowserWindow, dialog, ipcMain, Menu, nativeImage, nativeTheme, session, shell, Tray } from 'electron'
import { type Backend, pickPort, startBackend } from './backend'
import { type Bridge, startBridge } from './bridge'
import { appImage, ensureRuntime, iconPath, isDev, profileDir, serverEntry, serverRoot, sidedoorHome, trayIconPath } from './paths'
import { setupUpdater } from './updater'

/**
 * Sidedoor desktop: starts the server (a child process), shows the web app in a window, keeps the
 * scout running from the tray when the window closes, and lends the server Chromium for PDFs,
 * page reads and form windows (bridge.ts).
 */

// `Sidedoor --mcp`: the stdio MCP bridge the user's AI CLIs launch. No window, no single-instance lock.
if (process.argv.includes('--mcp')) {
  app.dock?.hide()
  const child = spawn(process.execPath, [serverEntry(), 'mcp'], { env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', SIDEDOOR_HOME: sidedoorHome() }, stdio: 'inherit' })
  child.on('exit', (code) => app.exit(code ?? 0))
} else {
  run()
}

function run() {
  app.setName(isDev ? 'Sidedoor Dev' : 'Sidedoor')
  const profile = profileDir()
  if (profile) app.setPath('userData', profile)
  if (!app.requestSingleInstanceLock()) {
    app.quit()
    return
  }

  const logDir = join(sidedoorHome(), 'userdata', 'logs')
  mkdirSync(logDir, { recursive: true })
  const logFile = join(logDir, 'desktop.log')
  const log = (line: string) => {
    if (isDev) console.log(line)
    try {
      appendFileSync(logFile, `${new Date().toISOString()} ${line}\n`)
    } catch {
      // disk full or similar; nothing useful to do
    }
  }

  let win: BrowserWindow | null = null
  let tray: Tray | null = null
  let backend: Backend | null = null
  let bridge: Bridge | null = null
  let quitting = false

  /** Settings the desktop app itself acts on, read from the server. */
  const appSettings = async (): Promise<{ runInBackground: boolean; allowNetwork: boolean }> => {
    try {
      if (!backend) throw new Error('no backend')
      const r = await fetch(`${backend.url}/api/rpc/settings`, { method: 'POST', headers: { authorization: `Bearer ${backend.token}`, 'content-type': 'application/json' }, body: '{}' })
      const j = (await r.json()) as { data: { settings: { app: { runInBackground: boolean; allowNetwork: boolean } } } }
      return j.data.settings.app
    } catch {
      return { runInBackground: true, allowNetwork: false }
    }
  }

  /** Network access is decided before the server starts: read it straight from the database. */
  const allowNetworkAtBoot = () => {
    try {
      const { DatabaseSync } = require('node:sqlite') as typeof import('node:sqlite')
      const db = new DatabaseSync(join(sidedoorHome(), 'userdata', 'sidedoor.sqlite'), { readOnly: true })
      const row = db.prepare("select value from settings where key = 'app'").get() as { value?: string } | undefined
      db.close()
      return !!(row?.value && (JSON.parse(row.value) as { app?: { allowNetwork?: boolean } }).app?.allowNetwork)
    } catch {
      return false
    }
  }

  /** Exact origin match: `startsWith` would accept http://127.0.0.1:4848@evil.com/ and :48481. */
  const isOurs = (url: string) => {
    try {
      const o = new URL(url).origin
      return o === new URL(backend!.url).origin || (!!process.env.SIDEDOOR_DEV_URL && o === new URL(process.env.SIDEDOOR_DEV_URL).origin)
    } catch {
      return false
    }
  }

  const appUrl = (path = '/') => (isDev && process.env.SIDEDOOR_DEV_URL ? `${process.env.SIDEDOOR_DEV_URL}${path}` : `${backend!.url}${path}`)

  const show = (path?: string) => {
    if (!win || win.isDestroyed()) createWindow()
    else {
      if (win.isMinimized()) win.restore()
      win.show()
      win.focus()
    }
    if (path) win?.webContents.send('sidedoor:navigate', path)
  }

  const createWindow = () => {
    win = new BrowserWindow({
      width: 1360,
      height: 900,
      minWidth: 900,
      minHeight: 600,
      show: false,
      title: 'Sidedoor',
      // No menu bar (like T3 Code): the menu's shortcuts still work, and Alt shows it.
      autoHideMenuBar: true,
      // Match the app's first paint (it follows the OS theme until settings load).
      backgroundColor: nativeTheme.shouldUseDarkColors ? '#17161c' : '#fbfaf7',
      ...(iconPath() ? { icon: iconPath()! } : {}),
      ...(process.platform === 'darwin' ? { titleBarStyle: 'hiddenInset' as const, trafficLightPosition: { x: 14, y: 14 } } : {}),
      webPreferences: { preload: join(__dirname, 'preload.cjs'), contextIsolation: true, sandbox: true, nodeIntegration: false },
    })
    win.once('ready-to-show', () => win?.show())
    // Links to other sites open in the user's browser; our own PDFs open in a window here.
    win.webContents.setWindowOpenHandler(({ url }) => {
      // Our own pages (PDFs) open in a plain window: no preload, so no desktop bridge in it.
      if (isOurs(url))
        return {
          action: 'allow',
          overrideBrowserWindowOptions: { width: 900, height: 1100, autoHideMenuBar: true, webPreferences: { preload: undefined, sandbox: true, contextIsolation: true, nodeIntegration: false } },
        }
      if (/^(https?|mailto):/.test(url)) void shell.openExternal(url)
      return { action: 'deny' }
    })
    // Windows opened from ours (PDFs) get the same rule: anything that isn't our page opens in the user's browser.
    win.webContents.on('did-create-window', (child) => {
      child.webContents.setWindowOpenHandler(({ url }) => {
        if (/^(https?|mailto):/.test(url)) void shell.openExternal(url)
        return { action: 'deny' }
      })
      child.webContents.on('will-navigate', (e, url) => {
        if (isOurs(url)) return
        e.preventDefault()
        if (/^(https?|mailto):/.test(url)) void shell.openExternal(url)
      })
    })
    win.webContents.on('will-navigate', (e, url) => {
      if (isOurs(url)) return
      e.preventDefault()
      if (/^(https?|mailto):/.test(url)) void shell.openExternal(url)
    })
    win.on('close', async (e) => {
      if (quitting) return
      // Keep the scout running from the tray, unless the user turned that off.
      e.preventDefault()
      const s = await appSettings()
      if (s.runInBackground && tray) win?.hide()
      else {
        quitting = true
        app.quit()
      }
    })
    void win.loadURL(appUrl())
  }

  const createTray = () => {
    const icon = trayIconPath()
    if (!icon) return
    const img = nativeImage.createFromPath(icon)
    tray = new Tray(process.platform === 'darwin' ? img.resize({ width: 18, height: 18 }) : img)
    tray.setToolTip('Sidedoor')
    tray.setContextMenu(
      Menu.buildFromTemplate([
        { label: 'Open Sidedoor', click: () => show() },
        { label: 'Today', click: () => show('/') },
        { label: 'New jobs', click: () => show('/jobs') },
        { type: 'separator' },
        {
          label: 'Quit Sidedoor',
          click: () => {
            quitting = true
            app.quit()
          },
        },
      ]),
    )
    tray.on('click', () => show())
  }

  const menu = () => {
    const isMac = process.platform === 'darwin'
    Menu.setApplicationMenu(
      Menu.buildFromTemplate([
        ...(isMac ? [{ role: 'appMenu' as const }] : []),
        { role: 'fileMenu' as const },
        { role: 'editMenu' as const },
        {
          label: 'View',
          submenu: [
            { label: 'Today', accelerator: 'CmdOrCtrl+1', click: () => show('/') },
            { label: 'Jobs', accelerator: 'CmdOrCtrl+2', click: () => show('/jobs') },
            { label: 'Pipeline', accelerator: 'CmdOrCtrl+3', click: () => show('/pipeline') },
            { label: 'People', accelerator: 'CmdOrCtrl+4', click: () => show('/people') },
            { label: 'Settings', accelerator: 'CmdOrCtrl+,', click: () => show('/settings') },
            { type: 'separator' },
            { role: 'reload' },
            { role: 'toggleDevTools' },
            { type: 'separator' },
            { role: 'resetZoom' },
            { role: 'zoomIn' },
            { role: 'zoomOut' },
            { role: 'togglefullscreen' },
          ],
        },
        { role: 'windowMenu' as const },
        {
          role: 'help' as const,
          submenu: [
            { label: 'Open data folder', click: () => void shell.openPath(sidedoorHome()) },
            { label: 'Open log', click: () => void shell.openPath(logFile) },
          ],
        },
      ]),
    )
  }

  /** Linux: an XDG autostart entry, which every desktop environment reads. */
  const autostartFile = () => join(app.getPath('home'), '.config', 'autostart', 'sidedoor.desktop')
  // A source install (`pnpm ship`) is opened through its launcher script, which sets its environment.
  const launcher = () => process.env.SIDEDOOR_LAUNCHER ?? appImage() ?? process.execPath
  const linuxAutostart = (on: boolean) => {
    const file = autostartFile()
    if (!on) return rmSync(file, { force: true })
    mkdirSync(dirname(file), { recursive: true })
    writeFileSync(file, `[Desktop Entry]\nType=Application\nName=Sidedoor\nExec="${launcher()}" --hidden\nIcon=sidedoor\nX-GNOME-Autostart-enabled=true\nComment=Your job search, run by your AI\n`)
  }

  const ipc = () => {
    ipcMain.on('sidedoor:version', (e) => (e.returnValue = app.getVersion()))
    ipcMain.handle('sidedoor:launch-at-login', (_e, on: boolean) => {
      if (process.platform !== 'linux') return app.setLoginItemSettings({ openAtLogin: on, args: ['--hidden'] })
      return linuxAutostart(on)
    })
    // Only our main window may use the bridge, and only for these.
    const fromApp = (e: Electron.IpcMainInvokeEvent) => !!win && e.sender === win.webContents && isOurs(e.senderFrame?.url ?? '')
    ipcMain.handle('sidedoor:open-external', (e, url: string) => (fromApp(e) && /^(https?|mailto):/.test(url) ? shell.openExternal(url) : undefined))
    // Opening a path is limited to Sidedoor's own data folder.
    ipcMain.handle('sidedoor:open-path', (e, p: string) => {
      const target = resolve(p)
      const home = resolve(sidedoorHome())
      if (!fromApp(e) || (target !== home && !target.startsWith(home + sep))) return 'not allowed'
      return shell.openPath(target)
    })
  }

  const stopAll = async () => {
    bridge?.close()
    await backend?.stop()
  }

  app.on('second-instance', () => show())
  app.on('activate', () => show())
  app.on('before-quit', (e) => {
    if (backend) {
      e.preventDefault()
      quitting = true
      const b = backend
      backend = null
      void b.stop().finally(() => app.quit())
    }
  })
  // With the tray, closing the last window keeps the app (and the scout) running.
  app.on('window-all-closed', () => {
    if (!tray) app.quit()
  })

  void app.whenReady().then(async () => {
    try {
      log(`[desktop] ${app.getVersion()} starting, server ${serverEntry()}`)
      menu()
      ipc()
      try {
        ensureRuntime()
      } catch (e) {
        log(`[desktop] could not copy the MCP runtime: ${String(e)}`)
      }
      bridge = await startBridge({ onNotifyClick: (path) => show(path) })
      const token = randomBytes(24).toString('base64url')
      const port = await pickPort(Number(process.env.SIDEDOOR_PORT ?? 4848))
      backend = await startBackend({
        port,
        token,
        host: allowNetworkAtBoot() ? '0.0.0.0' : '127.0.0.1',
        bridge: { url: bridge.url, token: bridge.token },
        onLog: log,
      })
      // The window is signed in with this launch's token; there's no login screen on desktop.
      // Only our own pages get permissions (clipboard, notifications); anything else in the default session gets none.
      session.defaultSession.setPermissionRequestHandler((wc, _perm, cb) => cb(isOurs(wc.getURL())))
      session.defaultSession.setPermissionCheckHandler((wc) => !!wc && isOurs(wc.getURL()))
      for (const url of [backend.url, ...(process.env.SIDEDOOR_DEV_URL ? [process.env.SIDEDOOR_DEV_URL] : [])])
        await session.defaultSession.cookies.set({ url, name: 'sidedoor_session', value: token, httpOnly: true, sameSite: 'strict', expirationDate: Date.now() / 1000 + 365 * 86400 })
      createTray()
      // An AppImage update changes the file name: point an existing AppImage autostart entry at this
      // one. Only from a packaged AppImage, so dev and test runs never touch the user's entry.
      const image = appImage()
      if (image && app.isPackaged && existsSync(autostartFile()) && /^Exec=".*\.AppImage"/im.test(readFileSync(autostartFile(), 'utf8')) && !readFileSync(autostartFile(), 'utf8').includes(image)) linuxAutostart(true)
      createWindow()
      setupUpdater({
        beforeInstall: async () => {
          // quitAndInstall closes windows before before-quit; without this the close handler hides to the tray instead.
          quitting = true
          await stopAll()
          backend = null
        },
      })
      const hidden = process.argv.includes('--hidden')
      if (hidden) win?.hide()
    } catch (e) {
      log(`[desktop] failed to start: ${e instanceof Error ? e.stack : String(e)}`)
      let tail = ''
      try {
        tail = readFileSync(logFile, 'utf8').split('\n').slice(-15).join('\n')
      } catch {
        // no log
      }
      dialog.showErrorBox('Sidedoor could not start', `${e instanceof Error ? e.message : String(e)}\n\n${tail}\n\nServer files: ${serverRoot()}`)
      app.exit(1)
    }
  })
}
