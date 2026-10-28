#!/usr/bin/env node
/**
 * Build a desktop installer for this OS (or --platform), like T3 Code's build-desktop-artifact:
 *   1. build the web app, the server bundle and the Electron main process
 *   2. stage only what ships into release/stage (Electron app) + release/stage/server
 *   3. install the few runtime dependencies there with npm (flat node_modules)
 *   4. run electron-builder --publish never
 *
 *   node scripts/build-desktop-artifact.mjs [--platform linux|mac|win] [--arch x64|arm64] [--skip-build] [--version 0.2.0] [--dir]
 *
 * Signing: set CSC_LINK / CSC_KEY_PASSWORD (+ APPLE_API_KEY, APPLE_API_KEY_ID, APPLE_API_ISSUER for
 * notarizing on macOS). Without them the build is unsigned.
 */
import { execFileSync } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'

const root = resolve(import.meta.dirname, '..')
const args = process.argv.slice(2)
const flag = (n, d) => {
  const i = args.indexOf(`--${n}`)
  return i >= 0 ? args[i + 1] : d
}
const has = (n) => args.includes(`--${n}`)
const platform = flag('platform', { darwin: 'mac', win32: 'win', linux: 'linux' }[process.platform])
const arch = flag('arch', process.arch === 'arm64' ? 'arm64' : 'x64')
const rootPkg = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8'))
const version = flag('version', process.env.SIDEDOOR_VERSION ?? rootPkg.version)
const owner = process.env.SIDEDOOR_GH_OWNER ?? 'TimothyKrell'
const repo = process.env.SIDEDOOR_GH_REPO ?? 'sidedoor'
const win32 = process.platform === 'win32'

const run = (cmd, argv, cwd = root, env = {}) => {
  console.log(`\n$ ${cmd} ${argv.join(' ')}  (${cwd.replace(root, '.') || '.'})`)
  execFileSync(cmd, argv, { cwd, stdio: 'inherit', shell: win32, env: { ...process.env, SIDEDOOR_VERSION: version, ...env } })
}

// 1. Build ------------------------------------------------------------------------------------
if (!has('skip-build')) {
  run('pnpm', ['--filter', '@sidedoor/web', 'build'])
  run('pnpm', ['--filter', '@sidedoor/server', 'build'])
  run('pnpm', ['--filter', '@sidedoor/desktop', 'build'])
}

// 2. Stage ------------------------------------------------------------------------------------
const stage = resolve(root, 'release/stage')
rmSync(stage, { recursive: true, force: true })
mkdirSync(stage, { recursive: true })
const desktop = resolve(root, 'apps/desktop')
const server = resolve(root, 'apps/server')
cpSync(resolve(desktop, 'dist-electron'), resolve(stage, 'dist-electron'), { recursive: true, filter: (p) => !p.endsWith('.map') })
cpSync(resolve(desktop, 'resources'), resolve(stage, 'build'), { recursive: true })
const srv = resolve(stage, 'server')
mkdirSync(srv, { recursive: true })
cpSync(resolve(server, 'dist'), resolve(srv, 'dist'), { recursive: true, filter: (p) => !p.endsWith('.map') })
for (const d of ['prompts', 'drizzle', 'defaults']) cpSync(resolve(server, d), resolve(srv, d), { recursive: true })
if (!existsSync(resolve(srv, 'dist/client/index.html'))) throw new Error('server/dist/client is missing; the web app did not build')

const serverPkg = JSON.parse(readFileSync(resolve(server, 'package.json'), 'utf8'))
const desktopPkg = JSON.parse(readFileSync(resolve(desktop, 'package.json'), 'utf8'))
// Packages the server bundle leaves external because they read their own files at runtime.
const SERVER_RUNTIME = ['playwright-core', '@playwright/mcp']
writeFileSync(
  resolve(srv, 'package.json'),
  JSON.stringify({ name: 'sidedoor-server', private: true, type: 'module', version, dependencies: Object.fromEntries(SERVER_RUNTIME.map((d) => [d, serverPkg.dependencies[d]])) }, null, 2),
)
run('npm', ['install', '--omit=dev', '--no-audit', '--no-fund', '--ignore-scripts', '--loglevel=error'], srv)

// Licenses ship in every installer: ours, the notices for adapted code, and every bundled library's.
cpSync(resolve(root, 'LICENSE'), resolve(stage, 'build/LICENSE.txt'))
cpSync(resolve(root, 'THIRD_PARTY_NOTICES.md'), resolve(stage, 'build/THIRD_PARTY_NOTICES.md'))
run('node', [resolve(root, 'scripts/third-party-licenses.mjs'), resolve(stage, 'build/THIRD_PARTY_LICENSES.txt')])

const build = {
  appId: 'app.sidedoor.desktop',
  productName: 'Sidedoor',
  artifactName: 'Sidedoor-${version}-${os}-${arch}.${ext}',
  copyright: 'Copyright © 2026 Timothy Krell',
  directories: { output: resolve(root, 'release/dist'), buildResources: 'build' },
  files: ['dist-electron/**/*', 'package.json'],
  extraResources: [
    { from: 'server', to: 'server', filter: ['**/*'] },
    { from: 'build/icon.png', to: 'icon.png' },
    { from: 'build/LICENSE.txt', to: 'LICENSE.txt' },
    { from: 'build/THIRD_PARTY_NOTICES.md', to: 'THIRD_PARTY_NOTICES.md' },
    { from: 'build/THIRD_PARTY_LICENSES.txt', to: 'THIRD_PARTY_LICENSES.txt' },
    { from: 'build/tray.png', to: 'tray.png' },
    { from: 'build/trayTemplate.png', to: 'trayTemplate.png' },
    { from: 'build/trayTemplate@2x.png', to: 'trayTemplate@2x.png' },
  ],
  asar: true,
  npmRebuild: false,
  // electron-builder drops node_modules from extraResources; the hook copies the server's in.
  afterPack: './after-pack.cjs',
  publish: [{ provider: 'github', owner, repo, releaseType: version.includes('-') ? 'prerelease' : 'release' }],
  mac: {
    category: 'public.app-category.productivity',
    target: ['dmg', 'zip'],
    icon: 'build/icon.png',
    hardenedRuntime: true,
    ...(process.env.CSC_LINK ? {} : { identity: null }),
    ...(process.env.APPLE_API_KEY ? { notarize: true } : {}),
  },
  dmg: { sign: false },
  linux: {
    target: ['AppImage', 'deb'],
    category: 'Office',
    icon: 'build/icons',
    executableName: 'sidedoor',
    desktop: { entry: { StartupWMClass: 'Sidedoor' } },
    synopsis: 'Your job search, run by your AI',
    maintainer: 'Sidedoor <hello@sidedoor.app>',
  },
  deb: { depends: ['libnss3', 'libgtk-3-0', 'libxss1', 'libasound2 | libasound2t64', 'libnotify4'] },
  win: { target: ['nsis'], icon: 'build/icon.ico' },
  nsis: { oneClick: true, perMachine: false, deleteAppDataOnUninstall: false, artifactName: 'Sidedoor-Setup-${version}-${arch}.${ext}' },
}
writeFileSync(
  resolve(stage, 'after-pack.cjs'),
  `const { cpSync } = require('node:fs')
const { join } = require('node:path')
exports.default = async (ctx) => {
  const resources = ctx.electronPlatformName === 'darwin' ? join(ctx.appOutDir, \`\${ctx.packager.appInfo.productFilename}.app\`, 'Contents', 'Resources') : join(ctx.appOutDir, 'resources')
  cpSync(join(__dirname, 'server', 'node_modules'), join(resources, 'server', 'node_modules'), { recursive: true })
}
`,
)
writeFileSync(
  resolve(stage, 'package.json'),
  JSON.stringify(
    {
      name: 'sidedoor',
      productName: 'Sidedoor',
      version,
      description: desktopPkg.description,
      author: { name: 'Timothy Krell', email: 'hello@sidedoor.app' },
      homepage: `https://github.com/${owner}/${repo}`,
      license: 'MIT',
      main: 'dist-electron/main.cjs',
      desktopName: 'sidedoor.desktop',
      dependencies: { 'electron-updater': desktopPkg.dependencies['electron-updater'] },
      devDependencies: { electron: desktopPkg.devDependencies.electron },
      build,
    },
    null,
    2,
  ),
)
run('npm', ['install', '--omit=dev', '--no-audit', '--no-fund', '--ignore-scripts', '--loglevel=error'], stage)

// 3. Package ----------------------------------------------------------------------------------
// Empty signing variables count as "set" to electron-builder; drop them (T3 Code does the same).
for (const k of ['CSC_LINK', 'CSC_KEY_PASSWORD', 'APPLE_API_KEY', 'APPLE_API_KEY_ID', 'APPLE_API_ISSUER']) if (process.env[k] === '') delete process.env[k]
const env = process.env.CSC_LINK ? {} : { CSC_IDENTITY_AUTO_DISCOVERY: 'false' }
const builder = resolve(desktop, 'node_modules/.bin/electron-builder')
run(builder, ['--projectDir', stage, `--${platform}`, `--${arch}`, '--publish', 'never', ...(has('dir') ? ['--dir'] : [])], stage, env)
console.log(`\nDone: release/dist (${platform} ${arch}, ${version})`)
