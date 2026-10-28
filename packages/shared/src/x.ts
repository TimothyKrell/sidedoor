/** "@jane", "jane", "x.com/jane", "https://twitter.com/jane/status/1" → "jane". Null when it isn't a handle. */
export const xHandle = (raw: string | null | undefined) => {
  const s = raw?.trim()
  if (!s) return null
  const m = /^(?:https?:\/\/)?(?:www\.|mobile\.)?(?:x|twitter)\.com\/(?:#!\/)?@?([A-Za-z0-9_]{1,15})(?:[/?#]|$)/i.exec(s) ?? /^@?([A-Za-z0-9_]{1,15})$/.exec(s)
  const h = m?.[1]
  return h && !/^(home|search|i|intent|messages|explore|settings|share|hashtag)$/i.test(h) ? h : null
}

/** Canonical profile URL for storage and links: https://x.com/<handle>. */
export const xUrl = (raw: string | null | undefined) => {
  const h = xHandle(raw)
  return h ? `https://x.com/${h}` : null
}
