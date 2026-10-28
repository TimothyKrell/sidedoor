import { readFileSync } from 'node:fs'
import { defineConfig } from 'tsdown'

const version = process.env.SIDEDOOR_VERSION ?? (JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')) as { version?: string }).version ?? '0.0.0'

// `pnpm ship` builds from a commit: Settings shows which one is running.
const build = process.env.SIDEDOOR_BUILD_COMMIT ? { commit: process.env.SIDEDOOR_BUILD_COMMIT, builtAt: new Date().toISOString() } : null

/**
 * One ESM file with every dependency inlined, except packages that read their own files at
 * runtime (Playwright). Those ship next to it in node_modules (scripts/stage-server.mjs).
 */
export default defineConfig({
  entry: { bin: 'src/bin.ts' },
  format: 'esm',
  platform: 'node',
  target: 'node24',
  outDir: 'dist',
  outExtensions: () => ({ js: '.mjs' }),
  clean: true,
  sourcemap: true,
  shims: true,
  define: { __SIDEDOOR_VERSION__: JSON.stringify(version), __SIDEDOOR_BUILD__: JSON.stringify(build) },
  external: ['playwright-core', 'playwright', '@playwright/mcp', /^playwright-core\//, /^@anthropic-ai\/claude-agent-sdk-/],
  noExternal: [/.*/],
  banner: { js: "#!/usr/bin/env node\nimport { createRequire as __sdCreateRequire } from 'node:module'; const require = __sdCreateRequire(import.meta.url);" },
})
