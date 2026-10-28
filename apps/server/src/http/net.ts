import { networkInterfaces } from 'node:os'

/** This computer's private LAN and Tailscale addresses, for phone pairing links. */
export const lanAddresses = () =>
  Object.values(networkInterfaces())
    .flat()
    .filter((i): i is NonNullable<typeof i> => !!i && i.family === 'IPv4' && !i.internal)
    .map((i) => i.address)
