import type { JiraClient } from '../jira/client'
import { adfToMarkdown } from '../jira/adf'

// Ticket Fetcher: the ticket as plain data for later blocks (summary, description as markdown, acceptance criteria when the
// description has them, labels, status, the last 20 comments). Agents receive it fenced as untrusted data by the engine.

export interface FetchedTicket {
  key: string
  summary: string
  description: string
  labels: string[]
  status: string
  comments: { author: string; date: string; text: string }[]
}

/** Lines under an "Acceptance criteria" heading (or label) up to the next heading; bullets/numbers are stripped. */
export function extractAcceptanceCriteria(markdown: string): string[] {
  const lines = markdown.split('\n')
  const start = lines.findIndex((l) => /^\s*(#{1,6}\s*|\*\*)?acceptance criteria\b/i.test(l))
  if (start < 0) return []
  const out: string[] = []
  const inline = lines[start].replace(/^\s*(#{1,6}\s*|\*\*)?acceptance criteria\b\**:?\**\s*/i, '').replace(/\*+$/, '').trim()
  if (inline) out.push(inline)
  for (const line of lines.slice(start + 1)) {
    if (/^\s*#{1,6}\s/.test(line)) break
    const t = line.replace(/^\s*(?:[-*+]|\d+[.)])\s+/, '').replace(/^\s*\[[ xX]\]\s*/, '').trim()
    if (t) out.push(t)
  }
  return out
}

export async function fetchTicket(jira: JiraClient, key: string): Promise<{ ticket: FetchedTicket; acceptanceCriteria: string[] }> {
  const issue = await jira.getIssue(key, ['summary', 'description', 'labels', 'status'])
  const comments = (await jira.recentComments(key, 20)).map((c) => ({
    author: c.author?.displayName ?? 'unknown',
    date: c.created ?? '',
    text: adfToMarkdown(c.body),
  }))
  const description = adfToMarkdown(issue.fields.description)
  return {
    ticket: { key, summary: issue.fields.summary ?? '', description, labels: issue.fields.labels ?? [], status: issue.fields.status?.name ?? '', comments },
    acceptanceCriteria: extractAcceptanceCriteria(description),
  }
}
