import path from 'path'
import { resolveInside } from './paths'

// Pure policy for the agentic runner's PreToolUse hook. Everything here is best-effort
// application-level containment (OS-level sandboxing is out of scope for v1): it stops the
// model from wandering outside its worktree or reaching the network through the tools AXON
// hands it, and every denial is reported back so it lands in toolsDenied.

export type ToolDecision = { allow: true } | { allow: false; reason: string }

/** The only environment an agent process gets — no Git/Jira tokens, nothing else. */
export const AGENT_ENV_ALLOWLIST = [
  'PATH', 'HOME', 'USERPROFILE', 'TEMP', 'TMP',
  // Windows needs these for child processes and the Claude binary to start at all.
  'SystemRoot', 'ComSpec', 'PATHEXT', 'APPDATA', 'LOCALAPPDATA', 'ProgramFiles', 'ProgramFiles(x86)',
] as const

export function buildAgentEnv(base: NodeJS.ProcessEnv, anthropicApiKey: string): Record<string, string> {
  const env: Record<string, string> = {}
  const lower = new Map(Object.keys(base).map((k) => [k.toLowerCase(), k]))
  for (const name of AGENT_ENV_ALLOWLIST) {
    const actual = base[name] !== undefined ? name : lower.get(name.toLowerCase())
    const value = actual ? base[actual] : undefined
    if (value !== undefined) env[name] = value
  }
  env.ANTHROPIC_API_KEY = anthropicApiKey
  return env
}

const PATH_KEYS = ['file_path', 'path', 'notebook_path', 'directory', 'cwd'] as const
const GLOB_KEYS = ['pattern', 'glob'] as const

const GLOB_CHARS = /[*?[\]{}]/

function outside(worktree: string, p: string): boolean {
  const abs = path.isAbsolute(p) ? p : path.join(worktree, p)
  return resolveInside(abs, [worktree]) === null
}

// A glob/pattern is a path only if it is anchored (absolute) or climbs with `..`. For anchored
// globs the static prefix before the first wildcard must stay in the worktree.
function globEscapes(worktree: string, pattern: string): boolean {
  const segs = pattern.split(/[\\/]/)
  if (segs.includes('..')) return true
  if (!path.isAbsolute(pattern) && !/^[A-Za-z]:/.test(pattern)) return false
  const idx = pattern.search(GLOB_CHARS)
  const prefix = idx === -1 ? pattern : pattern.slice(0, idx)
  const base = /[\\/]$/.test(prefix) ? prefix : path.dirname(prefix)
  return outside(worktree, base || pattern)
}

// ---------------------------------------------------------------- Bash

const NETWORK_COMMANDS = new Set([
  'curl', 'wget', 'invoke-webrequest', 'iwr', 'invoke-restmethod', 'irm', 'start-bitstransfer',
  'ssh', 'scp', 'sftp', 'ftp', 'tftp', 'rsync', 'nc', 'ncat', 'netcat', 'telnet', 'socat',
  'certutil', 'bitsadmin', 'test-netconnection', 'aria2c',
])
const NETWORK_SUBSTRINGS = ['net.webclient', 'system.net.', 'downloadstring', 'downloadfile']
const GIT_BLOCKED = new Set(['push', 'remote', 'clone', 'fetch', 'pull', 'ls-remote', 'submodule', 'credential', 'send-pack'])
const GIT_OPTIONS_WITH_VALUE = new Set(['-c', '-C', '--git-dir', '--work-tree', '--namespace', '--exec-path'])
const CD_COMMANDS = new Set(['cd', 'pushd', 'chdir', 'set-location', 'sl'])

// Quotes, backslashes and cmd's ^ are stripped so `c""url` / `cur\l` / `cu^rl` can't hide a name.
const deobfuscate = (w: string) => w.replace(/["'`\\^]/g, '')
const stripExt = (w: string) => w.replace(/\.(exe|cmd|bat|ps1|com)$/i, '').toLowerCase()
// Two readings of a word: path-aware (C:\x\curl.exe → curl) and escape-aware (cur\l → curl).
const baseNames = (w: string): string[] => [
  stripExt(deobfuscate(w.split(/[\\/]/).pop()!)),
  stripExt(deobfuscate(w).split('/').pop()!),
]

export function checkBashCommand(command: string, worktree: string): ToolDecision {
  const lower = command.toLowerCase()
  const squashed = deobfuscate(lower)
  for (const s of NETWORK_SUBSTRINGS) {
    if (squashed.includes(s)) return { allow: false, reason: `network access (${s})` }
  }

  // Split into statements on shell separators/subshell markers, then into words.
  const statements = command.split(/\r?\n|;|&&|\|\||\||&|`|\$\(|\(|\)|\{|\}/)
  for (const statement of statements) {
    const words = statement.trim().split(/\s+/).filter(Boolean)
    for (let i = 0; i < words.length; i++) {
      const names = baseNames(words[i])
      const name = names.find((n) => NETWORK_COMMANDS.has(n)) ?? names[0]
      if (NETWORK_COMMANDS.has(name)) return { allow: false, reason: `network command (${name})` }

      if (name === 'git') {
        let j = i + 1
        while (j < words.length && words[j].startsWith('-')) j += GIT_OPTIONS_WITH_VALUE.has(words[j]) ? 2 : 1
        const sub = words[j] ? deobfuscate(words[j]).toLowerCase() : ''
        if (GIT_BLOCKED.has(sub)) return { allow: false, reason: `git ${sub} is not allowed (AXON handles remotes)` }
      }

      if (CD_COMMANDS.has(name) && words[i + 1] && !words[i + 1].startsWith('-')) {
        const target = words[i + 1].replace(/["'`]/g, '') // keep backslashes: they are path separators here
        if (target.startsWith('~') || target.startsWith('$') || target.startsWith('%') || outside(worktree, target)) {
          return { allow: false, reason: 'changes directory outside the worktree' }
        }
      }
    }
  }
  return { allow: true }
}

// ---------------------------------------------------------------- entry point

export function decideToolUse(args: {
  toolName: string
  toolInput: unknown
  worktree: string
  effectiveTools: readonly string[]
}): ToolDecision {
  const { toolName, toolInput, worktree, effectiveTools } = args
  if (!effectiveTools.includes(toolName)) {
    return { allow: false, reason: `outside this block's resolved tool list` }
  }
  const input = (toolInput && typeof toolInput === 'object' ? toolInput : {}) as Record<string, unknown>

  for (const key of PATH_KEYS) {
    const v = input[key]
    if (typeof v !== 'string' || v === '') continue
    if (v.startsWith('~') || v.includes('\0') || outside(worktree, v)) {
      return { allow: false, reason: `path outside the delivery worktree (${key})` }
    }
  }
  for (const key of GLOB_KEYS) {
    const v = input[key]
    if (typeof v !== 'string' || v === '') continue
    // Grep's `pattern` is a regex, not a path — only Glob's pattern (and Grep's `glob`) are paths.
    if (key === 'pattern' && toolName !== 'Glob') continue
    if (globEscapes(worktree, v)) return { allow: false, reason: `glob escapes the delivery worktree (${key})` }
  }

  if (toolName === 'Bash') {
    const command = typeof input.command === 'string' ? input.command : ''
    return checkBashCommand(command, worktree)
  }
  return { allow: true }
}

/** Restrictive policy-tier deny rules (repo .claude/settings.json cannot override managed deny). */
export const MANAGED_DENY_RULES: readonly string[] = [
  'WebFetch', 'WebSearch', 'AskUserQuestion',
  'Bash(curl:*)', 'Bash(wget:*)', 'Bash(ssh:*)', 'Bash(scp:*)', 'Bash(nc:*)',
  'Bash(Invoke-WebRequest:*)', 'Bash(Invoke-RestMethod:*)',
  'Bash(git push:*)', 'Bash(git remote:*)',
]
