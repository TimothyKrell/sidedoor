/**
 * A CDP endpoint for one Electron page, so Playwright (in the server) can drive a window this app
 * owns. Electron allows one debugger client per webContents and has no browser-level target, so
 * this answers the browser-level Target/Browser calls itself and forwards page commands to
 * webContents.debugger.
 *
 * Adapted from T3 Code (apps/desktop/src/preview/CdpRelay.ts), MIT License, Copyright (c) 2026
 * T3 Tools Inc. Its license text is in THIRD_PARTY_NOTICES.md.
 */

export interface CdpRelayTarget {
  send: (method: string, params: Record<string, unknown>, sessionId: string | undefined) => Promise<unknown>
  /** The page's own CDP target id; Playwright keys the main frame by it. */
  targetId: () => Promise<string>
  url: () => string
  title: () => string
  userAgent: () => string
}

export interface CdpRelayConnection {
  receive: (raw: string) => void
  event: (method: string, params: unknown, sessionId: string | undefined) => void
}

interface CdpCommand {
  id: number
  method: string
  params?: Record<string, unknown>
  sessionId?: string
}

const isCommand = (v: unknown): v is CdpCommand => typeof v === 'object' && v !== null && typeof (v as { id?: unknown }).id === 'number' && typeof (v as { method?: unknown }).method === 'string'

const BROWSER_CONTEXT_ID = 'sidedoor-form'
const PAGE_SESSION_ID = 'sidedoor-page'
const ANNOUNCE = Symbol('announce')
const ACKNOWLEDGED = new Set(['Target.setDiscoverTargets', 'Browser.grantPermissions', 'Browser.resetPermissions', 'Browser.cancelDownload', 'Browser.setDownloadBehavior'])

export function createCdpRelay(target: CdpRelayTarget, write: (message: string) => void): CdpRelayConnection {
  const send = (m: Record<string, unknown>) => write(JSON.stringify(m))
  let attached = false
  const sessions = new Map<string, 'browser' | 'page'>([[PAGE_SESSION_ID, 'page']])
  let seq = 0
  const newSession = (kind: 'browser' | 'page') => {
    const id = `sidedoor-${kind}-${++seq}`
    sessions.set(id, kind)
    return id
  }
  const targetInfo = async () => ({ targetId: await target.targetId(), type: 'page', title: target.title(), url: target.url(), attached: true, canAccessOpener: false, browserContextId: BROWSER_CONTEXT_ID })

  const browserCommand = async (c: CdpCommand): Promise<unknown> => {
    if (ACKNOWLEDGED.has(c.method)) return {}
    switch (c.method) {
      case 'Browser.getVersion':
        return { protocolVersion: '1.3', product: 'Electron', revision: '', userAgent: target.userAgent(), jsVersion: '' }
      case 'Target.getTargetInfo':
        return { targetInfo: { targetId: 'browser', type: 'browser', title: '', url: '', attached: true, canAccessOpener: false } }
      case 'Target.getBrowserContexts':
        return { browserContextIds: [] }
      case 'Target.getTargets':
        return { targetInfos: [await targetInfo()] }
      case 'Target.attachToBrowserTarget':
        return { sessionId: newSession('browser') }
      case 'Target.attachToTarget': {
        if (c.params?.targetId !== (await target.targetId())) throw new Error('Only this form window can be attached.')
        return { sessionId: newSession('page') }
      }
      case 'Target.detachFromTarget': {
        const s = c.params?.sessionId
        if (typeof s === 'string' && s !== PAGE_SESSION_ID) sessions.delete(s)
        return {}
      }
      case 'Target.setAutoAttach': {
        if (attached) return {}
        attached = true
        return { [ANNOUNCE]: { method: 'Target.attachedToTarget', params: { sessionId: PAGE_SESSION_ID, targetInfo: await targetInfo(), waitingForDebugger: false } } }
      }
      default:
        throw new Error(`Not supported in a Sidedoor form window: ${c.method}`)
    }
  }

  const pageCommand = (c: CdpCommand): Promise<unknown> => {
    const child = sessions.get(c.sessionId!) === 'page' ? undefined : c.sessionId
    // The page is already running; child frames are paused by Playwright's
    // waitForDebuggerOnStart until this reaches them, so only swallow it for the page.
    if (c.method === 'Runtime.runIfWaitingForDebugger' && child === undefined) return Promise.resolve({})
    return target.send(c.method, c.params ?? {}, child)
  }

  return {
    receive: (raw) => {
      let c: unknown
      try {
        c = JSON.parse(raw)
      } catch {
        return
      }
      if (!isCommand(c)) return
      const cmd = c
      const result = cmd.sessionId === undefined || sessions.get(cmd.sessionId) === 'browser' ? browserCommand(cmd) : pageCommand(cmd)
      const route = cmd.sessionId === undefined ? {} : { sessionId: cmd.sessionId }
      void result.then(
        (value) => {
          const announce = typeof value === 'object' && value !== null && ANNOUNCE in value ? (value as { [ANNOUNCE]: Record<string, unknown> })[ANNOUNCE] : undefined
          send({ id: cmd.id, result: announce ? {} : (value ?? {}), ...route })
          if (announce) send(announce)
        },
        (e: unknown) => send({ id: cmd.id, error: { code: -32000, message: e instanceof Error ? e.message : String(e) }, ...route }),
      )
    },
    event: (method, params, sessionId) => {
      if (!attached) return
      if (method.startsWith('Browser.download')) return send({ method, params })
      // Electron reports the page's own events with an empty session id.
      if (sessionId) return send({ method, params, sessionId })
      for (const [id, kind] of sessions) if (kind === 'page') send({ method, params, sessionId: id })
    },
  }
}
