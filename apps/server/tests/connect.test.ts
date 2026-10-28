import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from 'vitest'
import { mcpAddArgs } from '../src/ai/connect'
import type { ProviderId } from '../src/ai/types'

// The real CLIs, each in a throwaway home: their argument parsing is what broke ("missing
// required argument 'commandOrUrl'" from Claude Code when -e came before the name).
const BIN: Record<ProviderId, string> = { claude: 'claude', codex: 'codex', grok: 'grok', opencode: 'opencode' }
const installed = (bin: string) => spawnSync('sh', ['-c', `command -v ${bin}`]).status === 0
const GET: Partial<Record<ProviderId, string[]>> = { claude: ['mcp', 'get', 'sidedoor'], codex: ['mcp', 'get', 'sidedoor'], grok: ['mcp', 'list'] }

for (const id of Object.keys(BIN) as ProviderId[]) {
  test.skipIf(!installed(BIN[id]))(`${id} accepts the bridge with an environment variable`, () => {
    const home = mkdtempSync(join(tmpdir(), `sd-connect-${id}-`))
    mkdirSync(join(home, '.config', 'opencode'), { recursive: true })
    const env = { ...process.env, HOME: home, XDG_CONFIG_HOME: join(home, '.config') }
    try {
      const add = spawnSync(BIN[id], mcpAddArgs(id, { command: '/bin/true', args: ['bridge.mjs', 'mcp'], env: { ELECTRON_RUN_AS_NODE: '1' } }), { cwd: home, env, encoding: 'utf8', timeout: 30_000 })
      expect(add.status, `${add.stdout}${add.stderr}`).toBe(0)
      const get = GET[id]
      if (get) expect(spawnSync(BIN[id], get, { cwd: home, env, encoding: 'utf8', timeout: 30_000 }).stdout).toMatch(/sidedoor/)
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  }, 60_000)
}
