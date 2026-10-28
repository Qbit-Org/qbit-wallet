import type { WebsiteUnverifiedReason } from '@qbit/wallet-shared'

type OriginUnverifiedReason = Exclude<WebsiteUnverifiedReason, 'detector-failure' | 'timeout'>

export type WebsiteOriginClassification =
  | { kind: 'public'; hostname: string }
  | { kind: 'unverified'; reason: OriginUnverifiedReason; hostname?: string }

const PRIVATE_NAME_SUFFIXES = [
  '.local',
  '.lan',
  '.home',
  '.home.arpa',
  '.internal',
  '.test',
  '.invalid',
  '.onion',
]

type Ipv4Octets = [number, number, number, number]
type Ipv6Groups = [number, number, number, number, number, number, number, number]

export function normalizeHostname(hostname: string): string {
  return hostname.trim().toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '')
}

function parseIpv4(hostname: string): Ipv4Octets | null {
  const parts = hostname.split('.')
  if (parts.length !== 4) return null

  const octets = parts.map(part => (/^(0|[1-9]\d{0,2})$/.test(part) ? Number(part) : -1))
  return octets.every(octet => octet >= 0 && octet <= 255)
    ? (octets as Ipv4Octets)
    : null
}

function parseIpv6(hostname: string): Ipv6Groups | null {
  let address = normalizeHostname(hostname)
  if (!address.includes(':') || address.includes('%')) return null

  const embeddedIpv4Match = address.match(/(?:^|:)(\d{1,3}(?:\.\d{1,3}){3})$/)
  if (embeddedIpv4Match) {
    const octets = parseIpv4(embeddedIpv4Match[1]!)
    if (!octets) return null
    const ipv4Groups = [
      ((octets[0] << 8) | octets[1]).toString(16),
      ((octets[2] << 8) | octets[3]).toString(16),
    ]
    address = `${address.slice(0, embeddedIpv4Match.index! + 1)}${ipv4Groups.join(':')}`
  }

  const halves = address.split('::')
  if (halves.length > 2) return null

  const left = halves[0] ? halves[0].split(':') : []
  const right = halves.length === 2 && halves[1] ? halves[1].split(':') : []
  const missing = 8 - left.length - right.length

  if ((halves.length === 1 && missing !== 0) || (halves.length === 2 && missing < 1)) {
    return null
  }

  const groups = [...left, ...Array(missing).fill('0'), ...right]
  if (groups.length !== 8 || groups.some(group => !/^[0-9a-f]{1,4}$/i.test(group))) {
    return null
  }

  return groups.map(group => Number.parseInt(group, 16)) as Ipv6Groups
}

function isValidDnsHostname(hostname: string): boolean {
  if (hostname.length > 253) return false

  return hostname.split('.').every(label => {
    if (label.length < 1 || label.length > 63) return false
    return /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/i.test(label)
  })
}

function isIpv4Loopback(octets: Ipv4Octets): boolean {
  return octets[0] === 127
}

function isNonPublicIpv4(octets: Ipv4Octets): boolean {
  const [a, b, c] = octets
  return (
    a === 0 ||
    a === 10 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 0 && c === 0) ||
    (a === 192 && b === 0 && c === 2) ||
    (a === 192 && b === 88 && c === 99) ||
    (a === 192 && b === 168) ||
    (a === 198 && (b === 18 || b === 19)) ||
    (a === 198 && b === 51 && c === 100) ||
    (a === 203 && b === 0 && c === 113) ||
    a >= 224
  )
}

function ipv4FromMappedIpv6(groups: Ipv6Groups): Ipv4Octets | null {
  const isMapped = groups.slice(0, 5).every(group => group === 0) && groups[5] === 0xffff
  const hasZeroPrefix = groups.slice(0, 6).every(group => group === 0)
  if (!isMapped && !hasZeroPrefix) return null

  return [groups[6] >> 8, groups[6] & 0xff, groups[7] >> 8, groups[7] & 0xff]
}

function isIpv6Loopback(groups: Ipv6Groups): boolean {
  return groups.slice(0, 7).every(group => group === 0) && groups[7] === 1
}

function isNonPublicIpv6(groups: Ipv6Groups): boolean {
  const mappedIpv4 = ipv4FromMappedIpv6(groups)
  if (mappedIpv4) return isIpv4Loopback(mappedIpv4) || isNonPublicIpv4(mappedIpv4)

  return (
    groups.every(group => group === 0) ||
    (groups[0] & 0xfe00) === 0xfc00 ||
    (groups[0] & 0xffc0) === 0xfe80 ||
    (groups[0] & 0xff00) === 0xff00 ||
    (groups[0] === 0x2001 && groups[1] === 0x0db8)
  )
}

export function classifyWebsiteOrigin(origin: string): WebsiteOriginClassification {
  if (typeof origin !== 'string' || origin.trim() === '') {
    return { kind: 'unverified', reason: 'malformed-origin' }
  }

  let url: URL
  try {
    url = new URL(origin.trim())
  } catch {
    return { kind: 'unverified', reason: 'malformed-origin' }
  }

  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return { kind: 'unverified', reason: 'unsupported-protocol' }
  }

  const hostname = normalizeHostname(url.hostname)
  if (
    !hostname ||
    url.username !== '' ||
    url.password !== '' ||
    url.pathname !== '/' ||
    url.search !== '' ||
    url.hash !== ''
  ) {
    return {
      kind: 'unverified',
      reason: 'malformed-origin',
      ...(hostname ? { hostname } : {}),
    }
  }

  const ipv4 = parseIpv4(hostname)
  const ipv6 = parseIpv6(hostname)

  if (!ipv4 && !ipv6 && !isValidDnsHostname(hostname)) {
    return { kind: 'unverified', reason: 'malformed-origin', hostname }
  }

  if (
    hostname === 'localhost' ||
    hostname.endsWith('.localhost') ||
    (ipv4 && isIpv4Loopback(ipv4)) ||
    (ipv6 && isIpv6Loopback(ipv6))
  ) {
    return { kind: 'unverified', reason: 'localhost', hostname }
  }

  if (
    (ipv4 && isNonPublicIpv4(ipv4)) ||
    (ipv6 && isNonPublicIpv6(ipv6)) ||
    (!ipv4 && !ipv6 && !hostname.includes('.')) ||
    PRIVATE_NAME_SUFFIXES.some(suffix => hostname.endsWith(suffix))
  ) {
    return { kind: 'unverified', reason: 'private-network', hostname }
  }

  if (url.protocol === 'http:') {
    return { kind: 'unverified', reason: 'insecure-protocol', hostname }
  }

  return { kind: 'public', hostname }
}
