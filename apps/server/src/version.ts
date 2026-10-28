/** Replaced at build time by the release version (tsdown `define`). */
declare const __SIDEDOOR_VERSION__: string | undefined
export const VERSION = typeof __SIDEDOOR_VERSION__ === 'string' ? __SIDEDOOR_VERSION__ : '0.0.0-dev'

/** The commit a local build (`pnpm ship`) was made from, and when; null for releases and dev. */
declare const __SIDEDOOR_BUILD__: { commit: string; builtAt: string } | null | undefined
export const BUILD = typeof __SIDEDOOR_BUILD__ === 'object' ? __SIDEDOOR_BUILD__ : null
