import { useEffect, useState } from 'react'
import { toast } from 'sonner'
import { Plus, Trash2 } from 'lucide-react'
import { Button } from '../ui/button'
import { Input } from '../ui/input'
import { SettingsCard, cleanError } from './parts'

// S5b: price per model ($ per million tokens). Prompt steps report tokens only, so this table turns them into an estimated
// cost (shown with "≈" in the Live View). Agentic steps keep the cost the Agent SDK reports; no price is baked into AXON.

interface Row { model: string; input: string; output: string }

/** The model Prompt (non-agentic) blocks call today. */
const PROMPT_MODEL = 'claude-haiku-4-5-20251001'

export function ModelPrices() {
  const [rows, setRows] = useState<Row[]>([])
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    window.axon.settings.get('modelPrices').then((v) => {
      const prices = (v && typeof v === 'object' ? v : {}) as Record<string, { inputPerMTok: number; outputPerMTok: number }>
      setRows(Object.entries(prices).map(([model, p]) => ({ model, input: String(p.inputPerMTok), output: String(p.outputPerMTok) })))
    }).catch(() => {})
  }, [])

  const update = (i: number, patch: Partial<Row>) => setRows((r) => r.map((x, j) => (j === i ? { ...x, ...patch } : x)))

  async function save() {
    const prices: Record<string, { inputPerMTok: number; outputPerMTok: number }> = {}
    for (const r of rows) {
      const model = r.model.trim()
      if (!model && !r.input && !r.output) continue
      const inp = Number(r.input)
      const out = Number(r.output)
      if (!model || !Number.isFinite(inp) || !Number.isFinite(out) || inp < 0 || out < 0) { toast.error(`Check the row for "${model || 'a model'}": a model id and two prices of 0 or more`); return }
      prices[model] = { inputPerMTok: inp, outputPerMTok: out }
    }
    setSaving(true)
    try {
      await window.axon.settings.set('modelPrices', prices)
      toast.success('Model prices saved')
    } catch (e) {
      toast.error(cleanError(e, 'Could not save the model prices'))
    } finally {
      setSaving(false)
    }
  }

  return (
    <SettingsCard
      title="Model prices"
      description="Dollars per million tokens, per model. Prompt steps only report tokens; with a price here they also get an estimated cost. Agentic steps keep the cost reported by the Agent SDK."
      footer={
        <>
          {!rows.some((r) => r.model === PROMPT_MODEL) && (
            <Button variant="outline" onClick={() => setRows((r) => [...r, { model: PROMPT_MODEL, input: '', output: '' }])}>Add the Prompt model</Button>
          )}
          <Button variant="outline" onClick={() => setRows((r) => [...r, { model: '', input: '', output: '' }])}><Plus /> Add model</Button>
          <Button onClick={save} disabled={saving}>{saving ? 'Saving…' : 'Save'}</Button>
        </>
      }
    >
      {rows.length === 0 && <p className="text-sm text-muted-foreground">No prices yet: Prompt steps show tokens but no cost.</p>}
      {rows.map((r, i) => (
        <div key={i} className="grid grid-cols-[1fr_7rem_7rem_auto] items-center gap-2" data-testid="price-row">
          <Input aria-label="Model id" value={r.model} onChange={(e) => update(i, { model: e.target.value })} placeholder="model id" spellCheck={false} className="font-mono" />
          <Input aria-label="Input price per million tokens" type="number" min={0} step="any" value={r.input} onChange={(e) => update(i, { input: e.target.value })} placeholder="$ in / M" />
          <Input aria-label="Output price per million tokens" type="number" min={0} step="any" value={r.output} onChange={(e) => update(i, { output: e.target.value })} placeholder="$ out / M" />
          <Button variant="ghost" size="icon" aria-label="Remove" onClick={() => setRows((x) => x.filter((_, j) => j !== i))}><Trash2 /></Button>
        </div>
      ))}
    </SettingsCard>
  )
}
