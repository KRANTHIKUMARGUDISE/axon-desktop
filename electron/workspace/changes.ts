import path from 'path'
import { defaultGit } from './snapshots'
import type { GitRun } from './snapshots'

// What an agent changed in a repo working tree (agents never commit, so this is `git status`): used by the gate
// review so the reviewer checks outcomes — which files changed — rather than reading diffs line by line.

export interface RepoChanges {
  /** Git top level folder. */
  repo: string
  name: string
  branch?: string
  files: { status: 'added' | 'modified' | 'deleted' | 'renamed' | 'other'; path: string }[]
  /** More files changed than are listed. */
  truncated: boolean
}

const MAX_FILES = 200

const statusOf = (xy: string): RepoChanges['files'][number]['status'] => {
  if (xy.includes('?') || xy.includes('A')) return 'added'
  if (xy.includes('D')) return 'deleted'
  if (xy.includes('R')) return 'renamed'
  if (xy.includes('M')) return 'modified'
  return 'other'
}

export async function changedFiles(cwd: string, git: GitRun = defaultGit): Promise<RepoChanges | null> {
  let top: string
  try {
    top = (await git(cwd, ['rev-parse', '--show-toplevel'])).trim()
  } catch {
    return null // not a git folder
  }
  if (!top) return null
  const raw = await git(top, ['status', '--porcelain=v1', '-z', '-uall'])
  const parts = raw.split('\0').filter(Boolean)
  const files: RepoChanges['files'] = []
  for (let i = 0; i < parts.length; i++) {
    const entry = parts[i]
    const xy = entry.slice(0, 2)
    files.push({ status: statusOf(xy), path: entry.slice(3) })
    if (xy.includes('R') || xy.includes('C')) i++ // -z lists the rename source as a separate entry
  }
  const branch = (await git(top, ['rev-parse', '--abbrev-ref', 'HEAD']).catch(() => '')).trim() || undefined
  return { repo: top, name: path.basename(top), branch, files: files.slice(0, MAX_FILES), truncated: files.length > MAX_FILES }
}
