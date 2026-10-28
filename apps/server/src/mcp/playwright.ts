import { mkdirSync } from 'node:fs'
import { pathToFileURL } from 'node:url'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { ListRootsRequestSchema } from '@modelcontextprotocol/sdk/types.js'
import { setBrowserClient } from './server'

/**
 * Attach Playwright MCP to a form window for the length of one fill, and expose its tools on
 * `/mcp/browser`. Every provider gets the same browser tools this way, through Sidedoor's own
 * endpoint, instead of each launching its own Playwright.
 */
export const withBrowserTools = async <T>(cdpEndpoint: string, workDir: string, fn: () => Promise<T>): Promise<T> => {
  const { createConnection } = (await import('@playwright/mcp')) as unknown as {
    createConnection: (config: Record<string, unknown>) => Promise<{ connect: (t: unknown) => Promise<void>; close: () => Promise<void> }>
  }
  // Playwright MCP's workspace is this fill's own folder (which holds just the files to upload):
  // it's the only root we advertise, so its file access isn't the server's working directory. The
  // proxy in mcp/server.ts allows only the tools and arguments a fill needs on top.
  mkdirSync(workDir, { recursive: true, mode: 0o700 })
  const server = await createConnection({
    browser: { cdpEndpoint },
    imageResponses: 'omit',
    outputDir: workDir,
  })
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair()
  await server.connect(serverSide)
  const client = new Client({ name: 'sidedoor-fill', version: '0.1.0' }, { capabilities: { roots: {} } })
  client.setRequestHandler(ListRootsRequestSchema, async () => ({ roots: [{ uri: pathToFileURL(workDir).href, name: 'Application files' }] }))
  await client.connect(clientSide)
  setBrowserClient(client, workDir)
  try {
    return await fn()
  } finally {
    setBrowserClient(null)
    await client.close().catch(() => {})
    await server.close().catch(() => {})
  }
}
