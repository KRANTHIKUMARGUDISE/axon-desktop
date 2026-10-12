// Pre-push secret scan for registry commits. A simple regex set (gitleaks-style) — it reports the
// rule name only, never the matched value.

export interface SecretRule {
  id: string
  re: RegExp
}

export const SECRET_RULES: readonly SecretRule[] = [
  { id: 'anthropic-api-key', re: /sk-ant-[A-Za-z0-9_-]{20,}/ },
  { id: 'github-token', re: /\bgh[pousr]_[A-Za-z0-9]{30,}\b/ },
  { id: 'github-fine-grained-pat', re: /\bgithub_pat_[A-Za-z0-9_]{40,}/ },
  { id: 'atlassian-api-token', re: /\bATATT[A-Za-z0-9_=+-]{20,}/ },
  { id: 'aws-access-key-id', re: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/ },
  { id: 'private-key', re: /-----BEGIN [A-Z ]*PRIVATE KEY-----/ },
  { id: 'slack-token', re: /\bxox[baprs]-[A-Za-z0-9-]{10,}/ },
  { id: 'bearer-token', re: /\bBearer\s+[A-Za-z0-9._~+/=-]{20,}/i },
  { id: 'basic-auth-url', re: /\bhttps?:\/\/[^\s/:@]+:[^\s/@]+@/ },
  { id: 'generic-secret-assignment', re: /\b(?:api[_-]?key|secret|token|passw(?:or)?d)["']?\s*[:=]\s*["']?[A-Za-z0-9/+_=.-]{20,}/i },
]

export class SecretFoundError extends Error {
  constructor(public readonly path: string, public readonly rule: string) {
    super(`Possible secret (${rule}) in ${path} — not pushed to the registry`)
  }
}

/** Rule id of the first match, or null. */
export function scanText(text: string): string | null {
  for (const rule of SECRET_RULES) if (rule.re.test(text)) return rule.id
  return null
}

export function assertNoSecrets(path: string, text: string): void {
  const rule = scanText(text)
  if (rule) throw new SecretFoundError(path, rule)
}
