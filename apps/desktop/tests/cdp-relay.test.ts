import { expect, test, vi } from 'vitest'
import { createCdpRelay, type CdpRelayTarget } from '../src/cdp-relay'

const target = (send: CdpRelayTarget['send'] = vi.fn(async () => ({ ok: true }))): CdpRelayTarget => ({
  send,
  targetId: async () => 'T1',
  url: () => 'https://jobs.example.com/apply',
  title: () => 'Apply',
  userAgent: () => 'UA',
})
const flush = () => new Promise((r) => setTimeout(r, 0))

test('auto-attach announces the one page, after the reply', async () => {
  const out: Array<Record<string, unknown>> = []
  const relay = createCdpRelay(target(), (m) => out.push(JSON.parse(m)))
  relay.receive(JSON.stringify({ id: 1, method: 'Target.setAutoAttach', params: { autoAttach: true } }))
  await flush()
  expect(out[0]).toEqual({ id: 1, result: {} })
  expect(out[1]).toMatchObject({ method: 'Target.attachedToTarget', params: { sessionId: 'sidedoor-page', targetInfo: { targetId: 'T1', type: 'page' } } })
})

test('page commands reach the debugger; child-frame sessions keep their id', async () => {
  const send = vi.fn(async () => ({ frameTree: {} }))
  const out: Array<Record<string, unknown>> = []
  const relay = createCdpRelay(target(send), (m) => out.push(JSON.parse(m)))
  relay.receive(JSON.stringify({ id: 2, method: 'Page.getFrameTree', sessionId: 'sidedoor-page' }))
  relay.receive(JSON.stringify({ id: 3, method: 'Runtime.enable', sessionId: 'CHILD' }))
  await flush()
  expect(send).toHaveBeenNthCalledWith(1, 'Page.getFrameTree', {}, undefined)
  expect(send).toHaveBeenNthCalledWith(2, 'Runtime.enable', {}, 'CHILD')
  expect(out).toContainEqual({ id: 2, result: { frameTree: {} }, sessionId: 'sidedoor-page' })
})

test("the running page isn't 'resumed', but paused child frames are", async () => {
  const send = vi.fn(async () => ({}))
  const relay = createCdpRelay(target(send), () => {})
  relay.receive(JSON.stringify({ id: 4, method: 'Runtime.runIfWaitingForDebugger', sessionId: 'sidedoor-page' }))
  relay.receive(JSON.stringify({ id: 5, method: 'Runtime.runIfWaitingForDebugger', sessionId: 'CHILD' }))
  await flush()
  expect(send).toHaveBeenCalledTimes(1)
  expect(send).toHaveBeenCalledWith('Runtime.runIfWaitingForDebugger', {}, 'CHILD')
})

test('other targets and unknown browser commands are refused', async () => {
  const out: Array<Record<string, unknown>> = []
  const relay = createCdpRelay(target(), (m) => out.push(JSON.parse(m)))
  relay.receive(JSON.stringify({ id: 6, method: 'Target.attachToTarget', params: { targetId: 'OTHER' } }))
  relay.receive(JSON.stringify({ id: 7, method: 'Target.createTarget', params: { url: 'about:blank' } }))
  await flush()
  expect(out.map((m) => m.id).sort()).toEqual([6, 7])
  expect(out.every((m) => 'error' in m)).toBe(true)
})

test('events reach the page session only once attached', async () => {
  const out: Array<Record<string, unknown>> = []
  const relay = createCdpRelay(target(), (m) => out.push(JSON.parse(m)))
  relay.event('Page.loadEventFired', {}, undefined)
  expect(out).toEqual([])
  relay.receive(JSON.stringify({ id: 1, method: 'Target.setAutoAttach', params: {} }))
  await flush()
  relay.event('Page.loadEventFired', { timestamp: 1 }, undefined)
  expect(out.at(-1)).toEqual({ method: 'Page.loadEventFired', params: { timestamp: 1 }, sessionId: 'sidedoor-page' })
})
