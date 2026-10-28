import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { resolve } from 'node:path'
import { findOnPath } from '../config'

/**
 * A Chromium-family browser already on this computer, for running without the desktop app
 * (`sidedoor serve`). The desktop app uses its own built-in browser instead.
 */
export const findChrome = (): string | null => {
  if (process.env.SIDEDOOR_CHROME && existsSync(process.env.SIDEDOOR_CHROME)) return process.env.SIDEDOOR_CHROME
  const candidates: string[] =
    process.platform === 'darwin'
      ? [
          '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
          '/Applications/Chromium.app/Contents/MacOS/Chromium',
          '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
          '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser',
          resolve(homedir(), 'Applications/Google Chrome.app/Contents/MacOS/Google Chrome'),
        ]
      : process.platform === 'win32'
        ? [
            ...[process.env.PROGRAMFILES, process.env['PROGRAMFILES(X86)'], process.env.LOCALAPPDATA].flatMap((d) =>
              d ? [resolve(d, 'Google/Chrome/Application/chrome.exe'), resolve(d, 'Microsoft/Edge/Application/msedge.exe'), resolve(d, 'Chromium/Application/chrome.exe')] : [],
            ),
          ]
        : []
  for (const c of candidates) if (existsSync(c)) return c
  for (const bin of ['chromium', 'chromium-browser', 'google-chrome', 'google-chrome-stable', 'microsoft-edge', 'brave-browser', 'brave']) {
    const p = findOnPath(bin)
    if (p) return p
  }
  return null
}

export const requireChrome = () => {
  const c = findChrome()
  if (!c) throw new Error('No Chrome, Edge or Chromium found. Install one, or use the Sidedoor desktop app, which has its own browser.')
  return c
}
