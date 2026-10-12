import fs from 'fs'
import path from 'path'

// Structured logger: JSON lines in {userData}/logs/axon.log with size-based rotation, and
// redaction of tokens, keys and emails-in-URLs. No electron import so it is unit-testable;
// main.ts calls initLogger(dir) once at boot. Before init, entries are dropped (never console).

export type LogLevel = 'debug' | 'info' | 'warn' | 'error'
const ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 }

const REDACTED = '[REDACTED]'

const PATTERNS: Array<[RegExp, string]> = [
  [/sk-ant-[A-Za-z0-9_-]{6,}/g, REDACTED],
  [/\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{10,}/g, REDACTED],
  [/github_pat_[A-Za-z0-9_]{10,}/g, REDACTED],
  [/\b(Bearer|Basic|token)\s+[A-Za-z0-9._~+/=-]{8,}/gi, '$1 [REDACTED]'],
  // user:password@ credentials embedded in URLs
  [/(:\/\/)[^\s/@:]+(?::[^\s/@]*)?@/g, '$1[REDACTED]@'],
  // emails (also covers emails in URL paths/queries)
  [/[A-Za-z0-9._%+-]+(?:@|%40)[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, '[REDACTED-EMAIL]'],
  [/((?:x-api-key|api[_-]?key|authorization|password|passwd|secret|token)["']?\s*[:=]\s*["']?)[^\s"',}]{4,}/gi, `$1${REDACTED}`],
]

const secrets = new Set<string>()

/** Registers an exact secret value to be scrubbed from every future log line. */
export function registerSecret(value: string | null | undefined): void {
  if (value && value.length >= 6) secrets.add(value)
}
export function clearRegisteredSecrets(): void {
  secrets.clear()
}

export function redact(input: string): string {
  let out = input
  for (const s of secrets) out = out.split(s).join(REDACTED)
  for (const [re, rep] of PATTERNS) out = out.replace(re, rep)
  return out
}

function safeStringify(value: unknown): string {
  if (typeof value === 'string') return value
  if (value instanceof Error) return `${value.name}: ${value.message}${value.stack ? `\n${value.stack}` : ''}`
  try {
    const seen = new WeakSet<object>()
    return JSON.stringify(value, (_k, v) => {
      if (v instanceof Error) return { name: v.name, message: v.message, stack: v.stack }
      if (typeof v === 'object' && v !== null) {
        if (seen.has(v)) return '[Circular]'
        seen.add(v)
      }
      return v
    })
  } catch {
    return String(value)
  }
}

export interface Logger {
  debug(msg: string, ...extra: unknown[]): void
  info(msg: string, ...extra: unknown[]): void
  warn(msg: string, ...extra: unknown[]): void
  error(msg: string, ...extra: unknown[]): void
}

export interface LoggerOptions {
  dir: string
  level?: LogLevel
  maxBytes?: number
  maxFiles?: number
  /** Mirror to the console (dev only). */
  mirror?: boolean
}

export function createLogger(opts: LoggerOptions): Logger {
  const { dir, level = 'info', maxBytes = 1_000_000, maxFiles = 3, mirror = false } = opts
  const file = path.join(dir, 'axon.log')
  let size = -1

  function rotate(): void {
    for (let i = maxFiles - 1; i >= 1; i--) {
      const from = i === 1 ? file : `${file}.${i - 1}`
      const to = `${file}.${i}`
      try {
        fs.renameSync(from, to)
      } catch {
        // missing file — nothing to rotate
      }
    }
    size = 0
  }

  function write(lvl: LogLevel, msg: string, extra: unknown[]): void {
    if (ORDER[lvl] < ORDER[level]) return
    const text = redact([msg, ...extra.map(safeStringify)].join(' '))
    const line = JSON.stringify({ t: new Date().toISOString(), level: lvl, msg: text }) + '\n'
    try {
      fs.mkdirSync(dir, { recursive: true })
      if (size < 0) size = fs.existsSync(file) ? fs.statSync(file).size : 0
      if (size + line.length > maxBytes) rotate()
      fs.appendFileSync(file, line)
      size += line.length
    } catch {
      // logging must never throw
    }
    if (mirror) {
      // eslint-disable-next-line no-console
      ;(lvl === 'error' ? console.error : lvl === 'warn' ? console.warn : console.log)(`[${lvl}] ${text}`)
    }
  }

  return {
    debug: (m, ...e) => write('debug', m, e),
    info: (m, ...e) => write('info', m, e),
    warn: (m, ...e) => write('warn', m, e),
    error: (m, ...e) => write('error', m, e),
  }
}

const noop: Logger = { debug() {}, info() {}, warn() {}, error() {} }
let current: Logger = noop

export function initLogger(opts: LoggerOptions): Logger {
  current = createLogger(opts)
  return current
}

/** Process-wide logger; a no-op until initLogger() runs (so tests stay quiet). */
export const log: Logger = {
  debug: (m, ...e) => current.debug(m, ...e),
  info: (m, ...e) => current.info(m, ...e),
  warn: (m, ...e) => current.warn(m, ...e),
  error: (m, ...e) => current.error(m, ...e),
}
