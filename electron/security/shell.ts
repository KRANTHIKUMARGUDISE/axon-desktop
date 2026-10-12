import path from 'path'
import { parseHttpsUrl } from '../../shared'

// Pure helpers for the shell:* handlers and window guards (no electron import → testable).

/** `https:` only, no embedded credentials. (`vscode:` is never accepted from the renderer.) */
export function isAllowedExternalUrl(value: unknown): boolean {
  return parseHttpsUrl(value) !== null
}

/** An argument handed to the `code` CLI: absolute, not option-like, no control chars. */
export function isSafeCliPathArg(value: string): boolean {
  if (!value || value.startsWith('-') || /[\0\r\n]/.test(value)) return false
  return path.isAbsolute(value) && !path.basename(value).startsWith('-')
}

/** vscode://file/<path> built by main from an already-validated path. */
export function buildVSCodeUri(resolvedPath: string): string {
  const p = resolvedPath.replace(/\\/g, '/')
  return `vscode://file/${p.split('/').map(encodeURIComponent).join('/').replace(/^([A-Za-z])%3A/, '$1:')}`
}

/** Same-origin test used by will-navigate / will-redirect. */
export function isSameAppOrigin(target: string, isTrusted: (url: string) => boolean): boolean {
  return isTrusted(target)
}
