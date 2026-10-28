import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import type { JSONRPCMessage } from '@modelcontextprotocol/sdk/types.js'
import { paths } from '../config'
import { agentToken } from '../secrets'

/**
 * `sidedoor mcp`: a stdio MCP server that forwards to the running app's `/mcp` endpoint. This is
 * what "Connect" registers in the user's Claude Code / Codex / Grok / OpenCode: their config holds
 * a command, never a port or token, so it keeps working when either changes.
 */
export const runtimeFile = () => resolve(paths.state, 'server-runtime.json')

export const runBridge = async (profile = '') => {
  const stdio = new StdioServerTransport()
  const fail = (id: string | number | undefined, message: string) =>
    void stdio.send({ jsonrpc: '2.0', id: id ?? 0, error: { code: -32000, message } } as JSONRPCMessage)
  let http: StreamableHTTPClientTransport | null = null
  const connect = async () => {
    if (http) return http
    const f = runtimeFile()
    if (!existsSync(f)) throw new Error('Sidedoor is not running. Open the Sidedoor app, then try again.')
    const { port } = JSON.parse(readFileSync(f, 'utf8')) as { port: number }
    const t = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp${profile ? `/${profile}` : ''}`), {
      requestInit: { headers: { Authorization: `Bearer ${agentToken()}` } },
    })
    t.onmessage = (m) => void stdio.send(m)
    t.onerror = (e) => console.error('[sidedoor mcp]', e.message)
    await t.start()
    http = t
    return t
  }
  stdio.onmessage = async (m) => {
    try {
      await (await connect()).send(m)
    } catch (e) {
      http = null
      fail('id' in m ? (m.id as string | number) : undefined, e instanceof Error ? e.message : String(e))
    }
  }
  stdio.onclose = () => process.exit(0)
  await stdio.start()
}
