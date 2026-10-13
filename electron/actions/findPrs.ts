import type { CatalogRepo } from '../workspace/provisioner'
import { ghApi, parseGitHubRepo } from './github'
import type { GitHubDeps } from './github'

// Find PRs: open pull requests in the catalog repositories whose branch name contains the ticket key. The result is a
// WorkItemList (one item per PR, `repo` = the catalog name) so Workspace Provisioner can check the branch out on any
// engineer's machine: stages hand over through GitHub, never through AXON-local state.

export interface FoundPr { repo: string; branch: string; url: string; number: number; title: string }

const MAX_REPOS = 60

/** `PAY-1` matches `axon/dev/PAY-1-abc` but not `PAY-12`. */
export function branchMentions(branch: string, ticketKey: string): boolean {
  const escaped = ticketKey.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return new RegExp(`(^|[^A-Za-z0-9])${escaped}(?![0-9])`, 'i').test(branch)
}

export async function findPrs(gh: GitHubDeps, catalog: CatalogRepo[], ticketKey: string): Promise<FoundPr[]> {
  const out: FoundPr[] = []
  for (const repo of catalog.slice(0, MAX_REPOS)) {
    const parsed = parseGitHubRepo(repo.url)
    if (!parsed) continue // GitHub only in v1
    for (let page = 1; page <= 3; page++) {
      const prs = await ghApi<{ number: number; title: string; html_url: string; head: { ref: string } }[]>(
        gh, 'GET', `https://api.github.com/repos/${parsed.owner}/${parsed.repo}/pulls?state=open&per_page=100&page=${page}`,
      )
      for (const p of prs) {
        if (branchMentions(p.head.ref, ticketKey)) out.push({ repo: repo.name, branch: p.head.ref, url: p.html_url, number: p.number, title: p.title })
      }
      if (prs.length < 100) break
    }
  }
  return out
}
