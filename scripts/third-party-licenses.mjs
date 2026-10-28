#!/usr/bin/env node
/**
 * Write THIRD_PARTY_LICENSES.txt: every library that ships in Sidedoor (the production
 * dependencies of the server, web app and desktop app), with its license text. The server and web
 * app are bundled into a few files, which drops the notices most licenses require us to keep, so
 * installers carry this file instead. Electron and Chromium's own licenses are added to every
 * installer by electron-builder (LICENSE.electron.txt, LICENSES.chromium.html).
 *
 *   node scripts/third-party-licenses.mjs [output path]   (default: ./THIRD_PARTY_LICENSES.txt)
 */
import { execFileSync } from 'node:child_process'
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

const root = resolve(import.meta.dirname, '..')
const out = resolve(process.argv[2] ?? join(root, 'THIRD_PARTY_LICENSES.txt'))

// `pnpm -r licenses list --json` prints one JSON object per workspace package, keyed by license.
const raw = execFileSync('pnpm', ['-r', 'licenses', 'list', '--prod', '--json'], { cwd: root, encoding: 'utf8', shell: process.platform === 'win32', maxBuffer: 64 * 1024 * 1024 })
const objects = []
for (let rest = raw.trim(); rest; ) {
  let depth = 0
  let end = 0
  let inString = false
  for (let i = 0; i < rest.length; i++) {
    const c = rest[i]
    if (inString) {
      if (c === '\\') i++
      else if (c === '"') inString = false
    } else if (c === '"') inString = true
    else if (c === '{') depth++
    else if (c === '}' && --depth === 0) {
      end = i + 1
      break
    }
  }
  if (!end) break
  objects.push(JSON.parse(rest.slice(0, end)))
  rest = rest.slice(end).trim()
}

const pkgs = new Map()
for (const o of objects)
  for (const [license, list] of Object.entries(o))
    for (const p of list) {
      if (p.name.startsWith('@sidedoor/')) continue
      const prev = pkgs.get(p.name)
      if (prev) prev.versions = [...new Set([...prev.versions, ...p.versions])]
      else pkgs.set(p.name, { name: p.name, versions: [...p.versions], license, path: p.paths?.[0], author: p.author, homepage: p.homepage })
    }

// LICENSE, LICENSE.md, LICENCE-MIT, COPYING… and Apache's NOTICE, which must be kept too.
const NOTICE_FILE = /^(licen[cs]e|copying|notice)([.-].*)?$/i
const texts = (dir) => {
  if (!dir || !existsSync(dir)) return []
  return readdirSync(dir)
    .filter((f) => NOTICE_FILE.test(f))
    .sort()
    .map((f) => readFileSync(join(dir, f), 'utf8').trim())
    .filter(Boolean)
}

// The permission text of our own LICENSE, for MIT packages that declare MIT but ship no file.
const MIT = readFileSync(join(root, 'LICENSE'), 'utf8').split('\n').slice(4).join('\n').trim()

const sections = [...pkgs.values()]
  .sort((a, b) => a.name.localeCompare(b.name))
  .map((p) => {
    const body = texts(p.path)
    const head = `${p.name} ${p.versions.join(', ')}\nLicense: ${p.license}${p.homepage ? `\n${p.homepage}` : ''}`
    const fallback =
      p.license === 'MIT'
        ? `(The package ships no license file; this is the standard MIT text it declares.)\n\nCopyright (c) ${p.author ?? `${p.name} authors`}\n\n${MIT}`
        : p.license === 'Unknown'
          ? 'See the package README for its terms.'
          : `${p.license}${p.author ? `, copyright ${p.author}` : ''}. The package ships no license file; the full text is at https://spdx.org/licenses/${encodeURIComponent(p.license)}.html.`
    return `${head}\n\n${body.length ? body.join('\n\n') : fallback}`
  })

writeFileSync(
  out,
  `Third-party software in Sidedoor\n\nSidedoor is MIT licensed (see LICENSE). It includes the ${sections.length} packages below, each under its own license.\n\n${'='.repeat(78)}\n\n${sections.join(`\n\n${'='.repeat(78)}\n\n`)}\n`,
)
console.log(`[licenses] ${sections.length} packages → ${out}`)
