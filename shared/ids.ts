const ALPHABET = 'abcdefghijklmnopqrstuvwxyz234567'

// 6-char base32 of a delivery id (D1): deterministic, ref-safe, collision-resistant enough
// to disambiguate branches for the same ticket.
export function shortId(deliveryId: string): string {
  const hex = deliveryId.replace(/[^0-9a-f]/gi, '').padEnd(8, '0').slice(0, 8)
  let n = parseInt(hex, 16) >>> 2 // 30 bits
  let out = ''
  for (let i = 0; i < 6; i++) {
    out = ALPHABET[n & 31] + out
    n >>>= 5
  }
  return out
}

// Git refs and path segments can't contain spaces or most specials, and ticket ids can be
// attacker-influenced — keep a conservative character set and never allow "..".
export function safeSegment(value: string, fallback = 'x'): string {
  const cleaned = value.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/\.{2,}/g, '.').replace(/^[-.]+|[-.]+$/g, '')
  return cleaned || fallback
}

export function slugify(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')
}
