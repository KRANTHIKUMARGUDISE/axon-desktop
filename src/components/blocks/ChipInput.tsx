import { useId, useState } from 'react'
import { X } from 'lucide-react'
import { Badge } from '../ui/badge'
import { Input } from '../ui/input'

/**
 * Type a name and press Enter (or comma) to add it as a chip; suggestions come from a datalist. Used for what a block needs,
 * the item fields of a work list, and tags.
 */
export function ChipInput({
  value, onChange, suggestions = [], placeholder, ariaLabel, validate,
}: {
  value: string[]
  onChange: (next: string[]) => void
  suggestions?: string[]
  placeholder?: string
  ariaLabel?: string
  /** Return an error message to refuse a value. */
  validate?: (v: string) => string | null
}) {
  const [text, setText] = useState('')
  const [error, setError] = useState<string | null>(null)
  const listId = useId()

  function commit(raw: string) {
    const v = raw.trim().replace(/,$/, '')
    if (!v) return
    const problem = validate?.(v) ?? null
    setError(problem)
    if (problem) return
    if (!value.includes(v)) onChange([...value, v])
    setText('')
  }

  return (
    <div className="flex flex-col gap-2">
      {value.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {value.map((v) => (
            <Badge key={v} variant="secondary" className="h-6 gap-1 pr-1 font-mono text-xs">
              {v}
              <button type="button" className="rounded-full p-0.5 hover:bg-foreground/10" onClick={() => onChange(value.filter((x) => x !== v))} aria-label={`Remove ${v}`}>
                <X className="size-3" />
              </button>
            </Badge>
          ))}
        </div>
      )}
      <Input
        value={text}
        list={listId}
        aria-label={ariaLabel}
        placeholder={placeholder}
        onChange={(e) => { setText(e.target.value); setError(null) }}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ',') { e.preventDefault(); commit(text) }
          else if (e.key === 'Backspace' && !text && value.length) onChange(value.slice(0, -1))
        }}
        onBlur={() => commit(text)}
        className="font-mono text-xs"
        aria-invalid={!!error}
      />
      <datalist id={listId}>{suggestions.filter((s) => !value.includes(s)).map((s) => <option key={s} value={s} />)}</datalist>
      {error && <p className="text-xs text-destructive">{error}</p>}
    </div>
  )
}
