import { useQuery } from '@tanstack/react-query'

/** `https://<site>.atlassian.net` from the Jira site chosen at onboarding, or null while Jira is not set up. */
export function useJiraBase(): string | null {
  const { data } = useQuery({
    queryKey: ['jira-site'],
    queryFn: () => window.axon.settings.get('jiraSite') as Promise<string>,
    staleTime: 5 * 60_000,
  })
  return typeof data === 'string' && data ? `https://${data}` : null
}
