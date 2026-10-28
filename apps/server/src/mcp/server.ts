import type { IncomingMessage, ServerResponse } from 'node:http'
import { isAbsolute, resolve, sep } from 'node:path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js'
import { z } from 'zod'
import { assertPublicUrl } from '../browser/guard-net'
import type { ToolDef } from './define'
import { SERVER_INSTRUCTIONS, type ToolProfile, toolsFor } from './tools'

/**
 * Sidedoor's MCP endpoint: streamable HTTP, stateless (a fresh server per request, like T3 Code's
 * `/mcp`). `/mcp` has every app tool; `/mcp/story` and `/mcp/lookup` are limited sets for story
 * interviews and JSON jobs; `/mcp/browser` adds the form-filling browser tools while a fill runs.
 */

export type McpProfile = ToolProfile | 'browser'

// ------------------------------------------------------------------ browser tools (form filling)

/**
 * The browser tools a form-filling agent gets: read the page, fill and click, upload the prepared
 * files. An allowlist, so a tool Playwright MCP adds later (file drops, network bodies, scripts) stays
 * off until someone decides it's safe.
 */
const ALLOWED_BROWSER_TOOLS = new Set([
  'browser_snapshot',
  'browser_take_screenshot',
  'browser_click',
  'browser_hover',
  'browser_drag',
  'browser_type',
  'browser_fill_form',
  'browser_select_option',
  'browser_press_key',
  'browser_file_upload',
  'browser_handle_dialog',
  'browser_wait_for',
  'browser_navigate',
  'browser_tabs',
])
export const isBlockedBrowserTool = (name: string) => !ALLOWED_BROWSER_TOOLS.has(name)
const SUBMITTY = /\bsubmit\b|send application|complete application/i

let browserClient: Client | null = null
let uploadRoot: string | null = null

/** While a fill runs, the Playwright MCP client attached to its window, and the only folder uploads may come from. */
export const setBrowserClient = (c: Client | null, root: string | null = null) => {
  browserClient = c
  uploadRoot = root ? resolve(root) : null
}

const denied = (text: string) => ({ content: [{ type: 'text', text: `Error: ${text}` }], isError: true })

/** Arguments a form-filling agent may not use, whatever the page tells it. */
export const browserArgsProblem = (name: string, args: Record<string, unknown>, root: string | null) => {
  // Tools that save to a file write wherever Playwright's workspace is; nothing a fill needs.
  if (args.filename !== undefined) return 'Saving to files is not allowed.'
  if (name === 'browser_navigate' || (name === 'browser_tabs' && args.url !== undefined)) {
    const url = String(args.url ?? '')
    if (!/^https?:\/\//i.test(url)) return 'Only web pages (http/https) can be opened.'
  }
  // Tabs: look and switch only. New tabs could open view-source: or file: pages.
  if (name === 'browser_tabs' && !['list', 'select'].includes(String(args.action))) return 'Only listing and switching tabs is allowed.'
  // "Type and press Enter" submits most forms.
  if (name === 'browser_type' && args.submit) return 'Sidedoor never submits applications; type without submit.'
  if (name === 'browser_file_upload') {
    const files = Array.isArray(args.paths) ? (args.paths as unknown[]).map(String) : []
    // No paths cancels the file chooser (a field we have no file for). Otherwise absolute paths
    // only: Playwright resolves relative ones against its own workspace, not this folder.
    if (!root || files.some((f) => !isAbsolute(f) || resolve(f) !== f || !f.startsWith(root + sep))) return 'Only the files Sidedoor prepared for this application can be uploaded (use their full paths).'
  }
  return null
}

const browserTools = async () => {
  if (!browserClient) return []
  const { tools } = await browserClient.listTools()
  return tools.filter((t) => !isBlockedBrowserTool(t.name))
}

const callBrowser = async (name: string, args: Record<string, unknown>) => {
  if (!browserClient) return { content: [{ type: 'text', text: 'Error: no form is open. Browser tools only work during a form fill.' }], isError: true }
  if (isBlockedBrowserTool(name)) return denied(`${name} is not allowed.`)
  const problem = browserArgsProblem(name, args, uploadRoot)
  if (problem) return denied(problem)
  if (name === 'browser_navigate') {
    try {
      await assertPublicUrl(String(args.url))
    } catch {
      return denied('Only public web pages can be opened.')
    }
  }
  // Second line of defense after the in-page guard: refuse clicks the agent itself calls submitting.
  if (name === 'browser_click' && [args.element, args.target, args.ref].some((v) => typeof v === 'string' && SUBMITTY.test(v)))
    return { content: [{ type: 'text', text: 'Sidedoor never submits applications. Stop here; the user reviews and submits.' }], isError: true }
  return browserClient.callTool({ name, arguments: args })
}

// ------------------------------------------------------------------ server

const jsonSchemaCache = new WeakMap<ToolDef, Record<string, unknown>>()
const inputJsonSchema = (t: ToolDef) => {
  let s = jsonSchemaCache.get(t)
  if (!s) {
    s = z.toJSONSchema(z.object(t.inputSchema), { target: 'draft-7', io: 'input' }) as Record<string, unknown>
    delete s.$schema
    jsonSchemaCache.set(t, s)
  }
  return s
}

const makeServer = (profile: McpProfile) => {
  const tools = toolsFor(profile === 'browser' ? 'app' : profile)
  const byName = new Map(tools.map((t) => [t.name, t]))
  const server = new Server({ name: 'sidedoor', version: '0.1.0' }, { capabilities: { tools: {} }, instructions: SERVER_INSTRUCTIONS })
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [
      ...tools.map((t) => ({ name: t.name, description: t.description, inputSchema: inputJsonSchema(t) as { type: 'object' }, ...(t.annotations ? { annotations: t.annotations } : {}) })),
      ...(profile === 'browser' ? await browserTools() : []),
    ],
  }))
  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const t = byName.get(req.params.name)
    const args = (req.params.arguments ?? {}) as Record<string, unknown>
    if (!t) {
      if (profile === 'browser' && req.params.name.startsWith('browser_')) return (await callBrowser(req.params.name, args)) as never
      return { content: [{ type: 'text', text: `Error: unknown tool ${req.params.name}` }], isError: true }
    }
    const parsed = z.object(t.inputSchema).safeParse(args)
    if (!parsed.success) return { content: [{ type: 'text', text: `Error: invalid arguments: ${parsed.error.message.slice(0, 800)}` }], isError: true }
    return (await t.handler(parsed.data as Record<string, unknown>)) as never
  })
  return server
}

export const handleMcp = async (req: IncomingMessage, res: ServerResponse, profile: McpProfile, body: unknown) => {
  if (req.method !== 'POST') {
    // Stateless: no server-initiated streams or sessions to resume.
    res.writeHead(405, { allow: 'POST' }).end()
    return
  }
  const server = makeServer(profile)
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true })
  res.on('close', () => {
    void transport.close()
    void server.close()
  })
  await server.connect(transport)
  await transport.handleRequest(req, res, body)
}

/** Run a tool in-process (tests, and the app calling its own tools). */
export const callTool = async (name: string, args: Record<string, unknown>) => {
  const t = toolsFor('app').find((x) => x.name === name)
  if (!t) throw new Error(`unknown tool ${name}`)
  return t.handler(z.object(t.inputSchema).parse(args) as Record<string, unknown>)
}
