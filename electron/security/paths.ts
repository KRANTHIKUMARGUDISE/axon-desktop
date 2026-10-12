import fs from 'fs'
import path from 'path'

// Path containment for every renderer-supplied or agent-supplied path.

const IS_WIN = process.platform === 'win32'

const norm = (p: string) => (IS_WIN ? p.toLowerCase() : p)

/** realpath of the deepest existing ancestor, with the non-existent tail re-appended. */
export function realpathDeepest(p: string): string {
  let current = path.resolve(p)
  const tail: string[] = []
  for (;;) {
    try {
      return path.join(fs.realpathSync.native(current), ...tail.reverse())
    } catch {
      const parent = path.dirname(current)
      if (parent === current) return path.resolve(p)
      tail.push(path.basename(current))
      current = parent
    }
  }
}

function isUncOrDevice(p: string): boolean {
  return /^[\\/]{2}/.test(p) || /^[A-Za-z]:(?![\\/])/.test(p)
}

export function isWithin(child: string, root: string): boolean {
  const c = norm(child)
  const r = norm(root)
  return c === r || c.startsWith(r.endsWith(path.sep) ? r : r + path.sep)
}

/**
 * Returns the resolved absolute path if it sits inside one of `roots` (symlinks/junctions
 * resolved on both sides), else null. `~`, relative-to-cwd, UNC and device paths are rejected:
 * callers must pass absolute paths.
 */
export function resolveInside(p: unknown, roots: readonly string[]): string | null {
  if (typeof p !== 'string' || !p || p.includes('\0')) return null
  if (p.startsWith('~')) return null
  if (!path.isAbsolute(p) || isUncOrDevice(p)) return null
  const resolved = realpathDeepest(p)
  for (const root of roots) {
    if (!root) continue
    if (isWithin(resolved, realpathDeepest(root))) return resolved
  }
  return null
}
