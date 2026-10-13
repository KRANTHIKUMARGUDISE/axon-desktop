import { ExternalLink } from 'lucide-react'
import { useJiraBase } from '@/hooks/useJiraBase'
import { cn } from '@/lib/utils'

/**
 * A ticket id that opens the ticket in Jira (system browser). Without a configured Jira site it is plain text.
 * It stops the click from reaching a surrounding row, so a table row can still open the delivery.
 */
export function JiraTicketLink({ ticket, className }: { ticket: string; className?: string }) {
  const base = useJiraBase()
  if (!base) return <span className={cn('font-mono font-semibold', className)}>{ticket}</span>
  const open = () => void window.axon.shell.openExternal(`${base}/browse/${encodeURIComponent(ticket)}`)
  return (
    <span
      role="link"
      tabIndex={0}
      title={`Open ${ticket} in Jira`}
      aria-label={`Open ${ticket} in Jira`}
      className={cn('inline-flex cursor-pointer items-center gap-1 font-mono font-semibold text-primary hover:underline', className)}
      onClick={(e) => { e.stopPropagation(); open() }}
      onKeyDown={(e) => { if (e.key === 'Enter') { e.stopPropagation(); open() } }}
    >
      {ticket}
      <ExternalLink className="size-3 shrink-0 opacity-70" />
    </span>
  )
}
