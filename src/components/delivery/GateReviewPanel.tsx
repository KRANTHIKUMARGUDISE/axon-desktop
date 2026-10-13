import { useQuery } from '@tanstack/react-query'
import { getGateReview } from '../../services/deliveriesService'

const STATUS_LABEL: Record<string, string> = { added: 'A', modified: 'M', deleted: 'D', renamed: 'R', other: '?' }
const STATUS_COLOR: Record<string, string> = { added: '#34d399', modified: '#fbbf24', deleted: '#f87171', renamed: '#60a5fa', other: '#94a3b8' }

const box: React.CSSProperties = {
  background: 'var(--axon-bg3)', border: '1px solid var(--axon-border2)', borderRadius: 6, padding: '7px 9px', marginBottom: 8,
}
const heading: React.CSSProperties = {
  fontSize: 10, fontWeight: 700, color: 'var(--axon-t3)', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 4,
}

/** Why a human decides here + what to check (always shown on a gate). */
export function GateReason({ reason, checklist, mode }: { reason?: string; checklist?: string[]; mode?: 'Pause' | 'NotifyOnly' }) {
  if (!reason && !(checklist && checklist.length)) return null
  return (
    <div data-testid="gate-reason" style={{ ...box, background: 'transparent', borderColor: 'rgba(245,158,11,0.25)' }}>
      {reason && (
        <>
          <div style={heading}>Why a human decides here</div>
          <div style={{ fontSize: 11.5, color: 'var(--axon-t1)', lineHeight: 1.5, overflowWrap: 'anywhere' }}>{reason}</div>
        </>
      )}
      {checklist && checklist.length > 0 && (
        <>
          <div style={{ ...heading, marginTop: reason ? 8 : 0 }}>What to check</div>
          <ul style={{ margin: 0, paddingLeft: 16, fontSize: 11, color: 'var(--axon-t2)', lineHeight: 1.5 }}>
            {checklist.map((c, i) => <li key={i}>{c}</li>)}
          </ul>
        </>
      )}
      {mode === 'NotifyOnly' && <div style={{ fontSize: 10.5, color: 'var(--axon-t3)', marginTop: 6 }}>Notify only: the run did not pause for this review.</div>}
    </div>
  )
}

/** Q7: outcomes, not lines — files changed per repo, test results and what each agent said it did. */
export function GateReviewPanel({ deliveryId }: { deliveryId: string }) {
  const { data, isLoading, isError } = useQuery({
    queryKey: ['gate-review', deliveryId],
    queryFn: () => getGateReview(deliveryId),
    staleTime: 0,
    refetchOnMount: 'always',
  })
  if (isLoading) return <div style={{ fontSize: 11, color: 'var(--axon-t3)', marginBottom: 8 }}>Loading review…</div>
  if (isError || !data) return null
  return (
    <div data-testid="gate-review">
      <div style={box} data-testid="gate-review-files">
        <div style={heading}>Files changed</div>
        {data.repos.length === 0 && <div style={{ fontSize: 11, color: 'var(--axon-t3)' }}>No repository changes to show.</div>}
        {data.repos.map((r) => (
          <div key={r.repo} style={{ marginBottom: 6 }}>
            <div style={{ fontSize: 11.5, fontWeight: 600, color: 'var(--axon-t1)' }}>
              {r.name}{r.branch ? <span style={{ fontWeight: 400, color: 'var(--axon-t3)' }}> · {r.branch}</span> : null}
              <span style={{ fontWeight: 400, color: 'var(--axon-t3)' }}> · {r.files.length}{r.truncated ? '+' : ''} file{r.files.length === 1 ? '' : 's'}</span>
            </div>
            {r.files.length === 0 ? (
              <div style={{ fontSize: 10.5, color: 'var(--axon-t3)' }}>No uncommitted changes.</div>
            ) : (
              <ul style={{ listStyle: 'none', margin: '3px 0 0', padding: 0, fontSize: 10.5, fontFamily: 'monospace', maxHeight: 130, overflowY: 'auto' }}>
                {r.files.map((f) => (
                  <li key={f.path} style={{ overflowWrap: 'anywhere' }}>
                    <span style={{ color: STATUS_COLOR[f.status] ?? '#94a3b8', display: 'inline-block', width: 14 }}>{STATUS_LABEL[f.status] ?? '?'}</span>
                    {f.path}
                  </li>
                ))}
              </ul>
            )}
          </div>
        ))}
      </div>

      {data.tests.length > 0 && (
        <div style={box} data-testid="gate-review-tests">
          <div style={heading}>Test results</div>
          {data.tests.map((t) => (
            <div key={t.nodeId} style={{ fontSize: 11, color: 'var(--axon-t2)', marginBottom: 4 }}>
              <b style={{ color: 'var(--axon-t1)' }}>{t.blockName}</b>{t.summary ? `: ${t.summary}` : ''}
              <pre style={{ margin: '2px 0 0', fontSize: 10, whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', maxHeight: 90, overflowY: 'auto' }}>
                {typeof t.result === 'string' ? t.result : JSON.stringify(t.result, null, 2)}
              </pre>
            </div>
          ))}
        </div>
      )}

      {data.agents.length > 0 && (
        <div style={box} data-testid="gate-review-agents">
          <div style={heading}>What the agents report</div>
          {data.agents.map((a, i) => (
            <div key={`${a.nodeId}-${a.itemKey ?? ''}-${i}`} style={{ fontSize: 11, color: 'var(--axon-t2)', marginBottom: 4, lineHeight: 1.45 }}>
              <b style={{ color: 'var(--axon-t1)' }}>{a.blockName}{a.itemKey ? ` · ${a.itemKey}` : ''}</b>: {a.summary || <em>no summary</em>}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
