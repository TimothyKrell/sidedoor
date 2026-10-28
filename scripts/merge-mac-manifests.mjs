#!/usr/bin/env node
// Each macOS job (arm64, x64) writes its own latest-mac.yml; electron-updater wants one file that
// lists both. Merge latest-mac-*.yml into latest-mac.yml (files from every arch, first one's
// version and release date).
import { readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const dir = process.argv[2] ?? 'assets'
const parts = readdirSync(dir).filter((f) => /^latest-mac-.+\.yml$/.test(f))
if (!parts.length) process.exit(0)
const files = []
let head = ''
for (const f of parts) {
  const text = readFileSync(join(dir, f), 'utf8')
  const lines = text.split('\n')
  const start = lines.findIndex((l) => l.startsWith('files:'))
  const end = lines.findIndex((l, i) => i > start && /^\S/.test(l))
  files.push(...lines.slice(start + 1, end === -1 ? undefined : end).filter(Boolean))
  if (!head) head = lines.filter((_, i) => i < start || (end !== -1 && i >= end)).join('\n')
  rmSync(join(dir, f))
}
const [before, ...after] = head.split('\n')
writeFileSync(join(dir, 'latest-mac.yml'), `${[before, 'files:', ...files, ...after].join('\n').trim()}\n`)
console.log(`merged ${parts.length} macOS manifests (${files.length} lines)`)
