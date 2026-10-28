// Is an address on this machine or the local network? Used to keep page reads and form windows on
// the public web: a posting could otherwise point the app at a router admin page or a local service.

const v4Private = (p: number[]) => {
  const [a = 0, b = 0] = p
  return a === 0 || a === 10 || a === 127 || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 198 && (b === 18 || b === 19)) || a >= 224
}

const parseV4 = (ip: string) => {
  const p = ip.split('.').map((x) => (/^\d{1,3}$/.test(x) ? Number(x) : Number.NaN))
  return p.length === 4 && p.every((n) => n >= 0 && n <= 255) ? p : null
}

/** An IPv6 address as eight 16-bit groups, or null. Accepts `::` and a dotted IPv4 tail. */
const parseV6 = (ip: string): number[] | null => {
  let s = ip
  const tail: number[] = []
  const dotted = s.match(/^(.*:)(\d+\.\d+\.\d+\.\d+)$/)
  if (dotted) {
    const v4 = parseV4(dotted[2]!)
    if (!v4) return null
    tail.push((v4[0]! << 8) | v4[1]!, (v4[2]! << 8) | v4[3]!)
    s = dotted[1]!.endsWith('::') ? dotted[1]! : dotted[1]!.slice(0, -1)
  }
  const halves = s.split('::')
  if (halves.length > 2) return null
  const groups = (h: string) => (h ? h.split(':').map((g) => (/^[0-9a-f]{1,4}$/.test(g) ? Number.parseInt(g, 16) : Number.NaN)) : [])
  const head = groups(halves[0]!)
  const rest = halves.length === 2 ? groups(halves[1]!) : []
  const fill = 8 - head.length - rest.length - tail.length
  if (halves.length === 1 ? fill !== 0 : fill < 0) return null
  const all = [...head, ...Array(halves.length === 2 ? fill : 0).fill(0), ...rest, ...tail]
  return all.length === 8 && all.every((n) => Number.isInteger(n)) ? all : null
}

const v4From = (hi: number, lo: number) => [hi >>> 8, hi & 255, lo >>> 8, lo & 255]

export const isPrivateAddress = (address: string) => {
  const ip = address.replace(/^\[|\]$/g, '').toLowerCase().replace(/%.*$/, '')
  if (!ip.includes(':')) {
    const v4 = parseV4(ip)
    // Anything that isn't a plain dotted quad is treated as private: callers only pass resolved addresses.
    return v4 ? v4Private(v4) : true
  }
  const g = parseV6(ip)
  if (!g) return true
  const zeros = (n: number) => g.slice(0, n).every((x) => x === 0)
  // ::, ::1, IPv4-compatible (::a.b.c.d) and IPv4-mapped (::ffff:a.b.c.d): judge the IPv4 inside.
  if (zeros(6)) return g[6] === 0 && (g[7] === 0 || g[7] === 1) ? true : v4Private(v4From(g[6]!, g[7]!))
  if (zeros(5) && g[5] === 0xffff) return v4Private(v4From(g[6]!, g[7]!))
  // IPv4-translated (::ffff:0:a.b.c.d) and local-use NAT64 (64:ff9b:1::/48) also carry one.
  if (zeros(4) && g[4] === 0xffff && g[5] === 0) return v4Private(v4From(g[6]!, g[7]!))
  if (g[0] === 0x64 && g[1] === 0xff9b && g[2] === 1) return true
  // NAT64 (64:ff9b::/96) and 6to4 (2002::/16) carry an IPv4 address too.
  if (g[0] === 0x64 && g[1] === 0xff9b && g.slice(2, 6).every((x) => x === 0)) return v4Private(v4From(g[6]!, g[7]!))
  if (g[0] === 0x2002) return v4Private(v4From(g[1]!, g[2]!))
  const first = g[0]!
  // Unique local fc00::/7, link-local fe80::/10, old site-local fec0::/10, multicast ff00::/8.
  return (first & 0xfe00) === 0xfc00 || (first & 0xffc0) === 0xfe80 || (first & 0xffc0) === 0xfec0 || (first & 0xff00) === 0xff00
}

export const isLocalHostname = (host: string) => {
  const h = host.replace(/^\[|\]$/g, '').toLowerCase().replace(/\.$/, '')
  return h === 'localhost' || h.endsWith('.localhost') || h.endsWith('.local') || h.endsWith('.internal') || h.endsWith('.lan') || h.endsWith('.home.arpa')
}
