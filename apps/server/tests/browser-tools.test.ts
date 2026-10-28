import { expect, test } from 'vitest'
import { browserArgsProblem, isBlockedBrowserTool } from '../src/mcp/server'

test('agents filling forms never get script or window-control browser tools', () => {
  for (const t of ['browser_evaluate', 'browser_run_code', 'browser_run_code_unsafe', 'browser_close', 'browser_install', 'browser_resize', 'browser_drop', 'browser_network_request', 'browser_network_requests', 'browser_console_messages', 'browser_some_future_tool']) expect(isBlockedBrowserTool(t), t).toBe(true)
  for (const t of ['browser_snapshot', 'browser_click', 'browser_fill_form', 'browser_file_upload', 'browser_select_option', 'browser_type', 'browser_tabs', 'browser_wait_for']) expect(isBlockedBrowserTool(t), t).toBe(false)
})

test('form agents may only open web pages and upload the files prepared for the fill', () => {
  const root = '/data/jobs/fill-1'
  expect(browserArgsProblem('browser_navigate', { url: 'https://jobs.example.com/apply' }, root)).toBeNull()
  expect(browserArgsProblem('browser_navigate', { url: 'file:///home/u/.ssh/id_ed25519' }, root)).not.toBeNull()
  expect(browserArgsProblem('browser_navigate', { url: 'chrome://settings' }, root)).not.toBeNull()
  expect(browserArgsProblem('browser_file_upload', { paths: ['/data/jobs/fill-1/resume.pdf'] }, root)).toBeNull()
  expect(browserArgsProblem('browser_file_upload', { paths: ['/home/u/.ssh/id_ed25519'] }, root)).not.toBeNull()
  expect(browserArgsProblem('browser_file_upload', { paths: ['/data/jobs/fill-1/../../secrets/agent-token.bin'] }, root)).not.toBeNull()
  expect(browserArgsProblem('browser_file_upload', { paths: ['/data/jobs/fill-1/resume.pdf'] }, null)).not.toBeNull()
  // Relative paths resolve against Playwright's workspace, not the fill folder.
  expect(browserArgsProblem('browser_file_upload', { paths: ['.ssh/id_rsa'] }, root)).not.toBeNull()
  expect(browserArgsProblem('browser_file_upload', { paths: ['resume.pdf'] }, root)).not.toBeNull()
  // Cancelling a chooser for a field we have no file for.
  expect(browserArgsProblem('browser_file_upload', { paths: [] }, root)).toBeNull()
  expect(browserArgsProblem('browser_file_upload', {}, root)).toBeNull()
  // No writing files, no new tabs (view-source:, file:), no typing that submits.
  expect(browserArgsProblem('browser_snapshot', { filename: '../../.bashrc' }, root)).not.toBeNull()
  expect(browserArgsProblem('browser_take_screenshot', { filename: 'x.png' }, root)).not.toBeNull()
  expect(browserArgsProblem('browser_tabs', { action: 'new', url: 'view-source:file:///etc/hostname' }, root)).not.toBeNull()
  expect(browserArgsProblem('browser_tabs', { action: 'new' }, root)).not.toBeNull()
  expect(browserArgsProblem('browser_tabs', { action: 'select', index: 1 }, root)).toBeNull()
  expect(browserArgsProblem('browser_type', { target: 'e5', text: 'hi', submit: true }, root)).not.toBeNull()
  expect(browserArgsProblem('browser_type', { target: 'e5', text: 'hi' }, root)).toBeNull()
})

test('page reads stay off this machine and the local network', async () => {
  const { isPrivateAddress } = await import('@sidedoor/shared/net')
  for (const ip of ['127.0.0.1', '10.1.2.3', '192.168.1.1', '172.20.0.5', '169.254.169.254', '100.100.1.1', '0.0.0.0', '::', '::1', '::ffff:127.0.0.1', '[::ffff:7f00:1]', '::7f00:1', '::127.0.0.1', '::ffff:0:7f00:1', '::ffff:0:127.0.0.1', '64:ff9b:1::8.8.8.8', '64:ff9b::7f00:1', '64:ff9b::10.0.0.1', '2002:7f00:1::', '2002:c0a8:101::1', 'fd12::1', 'fe80::1', 'fec0::1', 'ff02::1', 'fe80::1%eth0', 'not-an-ip', '1.2.3']) expect(isPrivateAddress(ip), ip).toBe(true)
  for (const ip of ['8.8.8.8', '104.16.1.1', '2606:4700::1111', '2001:4860:4860::8888', '64:ff9b::808:808', '2002:808:808::1', '::ffff:8.8.8.8']) expect(isPrivateAddress(ip), ip).toBe(false)
  const { isPublicHost } = await import('../src/browser/guard-net')
  expect(await isPublicHost('localhost')).toBe(false)
  expect(await isPublicHost('printer.local')).toBe(false)
  expect(await isPublicHost('[::ffff:127.0.0.1]')).toBe(false)
})

test('the public-only proxy refuses this machine, whatever the request form', async () => {
  const http = await import('node:http')
  const { startPublicProxy } = await import('@sidedoor/shared/public-proxy')
  const local = http.createServer((_q, r) => r.end('secret')).listen(0, '127.0.0.1')
  await new Promise((r) => local.once('listening', r))
  const port = (local.address() as { port: number }).port
  const proxy = await startPublicProxy()
  const viaProxy = (path: string) =>
    new Promise<number>((done, fail) => http.request({ host: '127.0.0.1', port: proxy.port, path, headers: { host: 'x' } }, (r) => done(r.statusCode ?? 0)).on('error', fail).end())
  const connect = (target: string) =>
    new Promise<number>((done, fail) => http.request({ host: '127.0.0.1', port: proxy.port, method: 'CONNECT', path: target }).on('connect', (r, sock) => { sock.destroy(); done(r.statusCode ?? 0) }).on('error', fail).end())
  try {
    for (const u of [`http://127.0.0.1:${port}/`, `http://localhost:${port}/`, `http://2130706433:${port}/`, `http://[::1]:${port}/`, `http://0x7f.1:${port}/`]) expect(await viaProxy(u), u).toBe(403)
    for (const t of [`127.0.0.1:${port}`, `localhost:${port}`, `[::ffff:127.0.0.1]:${port}`, `printer.local:443`]) expect(await connect(t), t).toBe(403)
  } finally {
    local.close()
    await proxy.close()
  }
})

test('nothing a local client sends crashes the proxy', async () => {
  const net = await import('node:net')
  const http = await import('node:http')
  const { startPublicProxy } = await import('@sidedoor/shared/public-proxy')
  const proxy = await startPublicProxy()
  const raw = (text: string, reset = false) =>
    new Promise<string>((done) => {
      const s = net.connect(proxy.port, '127.0.0.1', () => {
        s.write(text)
        if (reset) setTimeout(() => s.resetAndDestroy(), 20)
      })
      let got = ''
      s.on('data', (d) => (got += d))
      s.on('error', () => done(got))
      s.on('close', () => done(got))
      setTimeout(() => s.destroy(), 1500)
    })
  try {
    expect(await raw('CONNECT 8.8.8.8:70000 HTTP/1.1\r\nHost: 8.8.8.8:70000\r\n\r\n')).toContain('400')
    expect(await raw('CONNECT 8.8.8.8:0 HTTP/1.1\r\n\r\n')).toContain('400')
    await raw('GET http://8.8.8.8:99999/ HTTP/1.1\r\nHost: x\r\n\r\n')
    await raw('GET ws://example.com/ HTTP/1.1\r\nHost: example.com\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n', true)
    await raw('garbage\r\n\r\n')
    // Still serving.
    const status = await new Promise<number>((done, fail) => http.request({ host: '127.0.0.1', port: proxy.port, path: 'http://127.0.0.1:1/' }, (r) => done(r.statusCode ?? 0)).on('error', fail).end())
    expect(status).toBe(403)
  } finally {
    await proxy.close()
  }
})
