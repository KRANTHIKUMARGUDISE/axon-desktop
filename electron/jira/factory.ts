import { JiraClient } from './client'
import { readJiraIdentity } from '../ipc/settings'
import { getJiraToken } from '../ipc/secrets'

/** A client for the verified Jira account (site + email from onboarding, token from safeStorage); null until configured. */
export async function makeJiraClient(): Promise<JiraClient | null> {
  const id = readJiraIdentity()
  const token = await getJiraToken()
  if (!id || !token) return null
  return new JiraClient({ site: id.site, email: id.email, token })
}
