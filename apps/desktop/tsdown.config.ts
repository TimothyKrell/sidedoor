import { defineConfig, type UserConfig } from 'tsdown'

// Main process and preload as CommonJS. Electron's sandboxed preload can't load ESM or any file
// but `electron`, so the preload is its own build: built together, the bundler moves helpers they
// share into main.cjs and the preload's `require('./main.cjs')` fails, leaving the page without
// the desktop bridge. Only `electron` stays external.
// No `clean`: the two builds share the folder, and one cleaning it could delete the other's file.
const common: UserConfig = {
  format: 'cjs',
  platform: 'node',
  target: 'node24',
  outDir: 'dist-electron',
  outExtensions: () => ({ js: '.cjs' }),
  sourcemap: true,
  external: ['electron', 'electron-updater'],
  noExternal: [/^(?!electron(-updater)?$).*/],
}

export default defineConfig([
  { ...common, entry: { main: 'src/main.ts' } },
  { ...common, entry: { preload: 'src/preload.ts' } },
])
