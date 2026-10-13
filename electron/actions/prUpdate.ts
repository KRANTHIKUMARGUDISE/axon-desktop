import crypto from 'crypto'
import type { PrUpdateConfig, TemplateData } from '../../shared'
import { renderTemplate } from '../../shared'
import { ghApi, parsePrUrl } from './github'
import type { GitHubDeps } from './github'

// The PR Update action: labels, reviewers, ready-for-review and a comment on the PRs from PR Creator / Find PRs.
// Idempotent: adding a label or reviewer again is a no-op on GitHub, "ready for review" only acts on drafts, and the
// comment carries an invisible HTML marker that is searched first.

export interface PrActionEnv {
  gh: GitHubDeps
  prs: { repo: string; url: string }[]
  data: TemplateData
  markerBase: string
}

const hash = (s: string) => crypto.createHash('sha1').update(s).digest('hex').slice(0, 10)
const API = 'https://api.github.com'

export async function runPrUpdate(cfg: PrUpdateConfig, env: PrActionEnv): Promise<{ summary: string; changes: string[] }> {
  if (!env.prs.length) throw new Error('PR Update found no pull requests (it needs PR Creator or Find PRs before it)')
  const changes: string[] = []
  for (const pr of env.prs) {
    const ref = parsePrUrl(pr.url)
    if (!ref) throw new Error(`Not a GitHub pull request URL: ${pr.url}`)
    const base = `${API}/repos/${ref.owner}/${ref.repo}`
    const name = `${ref.owner}/${ref.repo}#${ref.number}`
    const pull = await ghApi<{ draft?: boolean; node_id?: string; labels?: { name: string }[]; requested_reviewers?: { login: string }[] }>(env.gh, 'GET', `${base}/pulls/${ref.number}`)

    const haveLabels = new Set((pull.labels ?? []).map((l) => l.name))
    const labels = cfg.addLabels.filter((l) => !haveLabels.has(l))
    if (labels.length) {
      await ghApi(env.gh, 'POST', `${base}/issues/${ref.number}/labels`, { labels })
      changes.push(`labelled ${name} ${labels.join(', ')}`)
    }

    const haveReviewers = new Set((pull.requested_reviewers ?? []).map((r) => r.login.toLowerCase()))
    const reviewers = cfg.reviewers.filter((r) => !haveReviewers.has(r.toLowerCase()))
    if (reviewers.length) {
      await ghApi(env.gh, 'POST', `${base}/pulls/${ref.number}/requested_reviewers`, { reviewers })
      changes.push(`requested review from ${reviewers.join(', ')} on ${name}`)
    }

    if (cfg.readyForReview && pull.draft && pull.node_id) {
      await ghApi(env.gh, 'POST', `${API}/graphql`, {
        query: 'mutation($id: ID!) { markPullRequestReadyForReview(input: { pullRequestId: $id }) { pullRequest { number } } }',
        variables: { id: pull.node_id },
      })
      changes.push(`marked ${name} ready for review`)
    }

    if (cfg.comment) {
      const text = renderTemplate(cfg.comment, { ...env.data, prUrls: env.data.prUrls }).trim()
      if (text) {
        const marker = `<!-- ${env.markerBase}:${hash(`${pr.url}\n${text}`)} -->`
        const existing = await ghApi<{ body?: string }[]>(env.gh, 'GET', `${base}/issues/${ref.number}/comments?per_page=100`)
        if (!existing.some((c) => c.body?.includes(marker))) {
          await ghApi(env.gh, 'POST', `${base}/issues/${ref.number}/comments`, { body: `${text}\n\n${marker}` })
          changes.push(`commented on ${name}`)
        }
      }
    }
  }
  const text = changes.length ? changes.join('; ') : `No change needed on ${env.prs.length} pull request(s)`
  return { summary: text.charAt(0).toUpperCase() + text.slice(1), changes }
}
