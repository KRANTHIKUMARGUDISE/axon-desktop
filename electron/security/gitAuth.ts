import fs from 'fs/promises'
import path from 'path'

// Git credentials never travel in URLs or argv: they reach git through an environment-driven
// GIT_ASKPASS helper. The helper script itself contains no secret — it echoes env vars that
// exist only in the spawned git process.

/** Applied to every network git invocation (clone/fetch/pull/push). */
export const GIT_NET_CONFIG: readonly string[] = [
  'protocol.ext.allow=never',
  'protocol.file.allow=never',
]

// Flags simple-git requires before it will accept the (fixed, AXON-authored) config/env above.
// User-controlled data (repo URL) is validated separately and never reaches these paths.
export const GIT_UNSAFE_ALLOW = {
  allowUnsafeProtocolOverride: true,
  allowUnsafeAskPass: true,
  allowUnsafeCredentialHelper: true,
} as const

/** https://, ssh://, or scp-like user@host:path. Rejects ext::, file:, local paths, options. */
export function validateRepoUrl(url: unknown): string {
  if (typeof url !== 'string') throw new Error('Repository URL must be a string')
  const u = url.trim()
  if (!u || u.length > 2048 || /[\0\r\n\s]/.test(u)) throw new Error('Invalid repository URL')
  if (u.startsWith('-')) throw new Error('Invalid repository URL')
  if (/^https:\/\/[^\s/@]+(:[^\s/@]*)?@/.test(u)) throw new Error('Repository URL must not embed credentials')
  if (/^https:\/\/[^\s/]+\/.+/.test(u)) return u
  if (/^ssh:\/\/[^\s/]+\/.+/.test(u)) return u
  if (/^[A-Za-z0-9._-]+@[A-Za-z0-9.-]+:[^\s:][^\s]*$/.test(u)) return u
  throw new Error('Repository URL must be https://, ssh:// or git@host:path')
}

// simple-git 4 refuses to spawn git while these are present in the environment (editor, pager,
// alternate exec/template/config paths, custom ssh/proxy commands, askpass): each can run an
// arbitrary program. AXON never needs the user's interactive setup for these, so the inherited
// values are dropped (case-insensitively) and only our own askpass is set back below.
const BLOCKED_INHERITED_ENV = new Set([
  'editor', 'visual', 'git_editor', 'git_sequence_editor', 'pager', 'git_pager',
  'git_exec_path', 'git_external_diff', 'git_proxy_command', 'git_template_dir',
  'git_ssh', 'git_ssh_command', 'git_askpass', 'ssh_askpass', 'prefix',
  'git_config', 'git_config_global', 'git_config_system', 'git_config_count', 'git_config_parameters',
])
const isIndexedGitConfig = (k: string) => /^git_config_(key|value)_\d+$/i.test(k)

const SECRET_ENV = /(TOKEN|SECRET|PASSWORD|API_?KEY|PASSWD|CREDENTIAL)/i

/** Environment for a git child: the parent env minus anything secret-looking, plus askpass. */
export function buildGitEnv(
  base: NodeJS.ProcessEnv,
  opts: { token?: string | null; askpassPath?: string },
): Record<string, string> {
  const env: Record<string, string> = {}
  for (const [k, v] of Object.entries(base)) {
    if (v === undefined) continue
    if (SECRET_ENV.test(k) && !/^SSH_AUTH_SOCK$/.test(k)) continue
    if (BLOCKED_INHERITED_ENV.has(k.toLowerCase()) || isIndexedGitConfig(k)) continue
    env[k] = v
  }
  env.GIT_TERMINAL_PROMPT = '0'
  if (opts.token && opts.askpassPath) {
    env.GIT_ASKPASS = opts.askpassPath.replace(/\\/g, '/')
    env.AXON_GIT_USERNAME = 'git'
    env.AXON_GIT_PASSWORD = opts.token
  }
  return env
}

const ASKPASS_SCRIPT = `#!/bin/sh
case "$1" in
  Username*|username*) printf '%s\n' "$AXON_GIT_USERNAME" ;;
  *) printf '%s\n' "$AXON_GIT_PASSWORD" ;;
esac
`

/** Writes {dir}/askpass.sh (idempotent) and returns its path. */
export async function ensureAskpassScript(dir: string): Promise<string> {
  await fs.mkdir(dir, { recursive: true })
  const file = path.join(dir, 'askpass.sh')
  await fs.writeFile(file, ASKPASS_SCRIPT, { mode: 0o700 })
  return file
}
