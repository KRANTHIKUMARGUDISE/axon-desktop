import { ShieldCheck } from 'lucide-react'
import { Badge } from '@/components/ui/badge'

/**
 * Always visible, never toggled — this is a standing commitment of the
 * Intelligence section, not a dismissible notice.
 */
export function TransparencyBadge() {
  return (
    <Badge variant="secondary" className="gap-1.5 py-1">
      <ShieldCheck className="size-3.5" />
      Transparency, not ranking
    </Badge>
  )
}
