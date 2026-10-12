import { useNavigate } from 'react-router-dom'
import { useDeliveries } from '@/hooks/useDeliveries'
import { usePipelines } from '@/hooks/usePipelines'
import NewDeliveryModal, { useNewDeliveryModal } from '@/components/delivery/NewDeliveryModal'
import StatCards from '@/components/dashboard/StatCards'
import ActiveDeliveries from '@/components/dashboard/ActiveDeliveries'
import QuickLaunch from '@/components/dashboard/QuickLaunch'
import RecentActivity from '@/components/dashboard/RecentActivity'

function Card({ children, className = '' }: { children: React.ReactNode; className?: string }) {
  return (
    <div
      className={className}
      style={{
        background: 'var(--axon-bg2)',
        border: '1px solid var(--axon-border)',
        borderRadius: 12,
        padding: 18,
      }}
    >
      {children}
    </div>
  )
}

function SectionHeader({ title, action }: { title: string; action?: React.ReactNode }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12 }}>
      <span style={{ fontSize: 13, fontWeight: 600, color: 'var(--axon-t1)' }}>{title}</span>
      {action}
    </div>
  )
}

export default function Dashboard() {
  const navigate = useNavigate()
  const modal = useNewDeliveryModal()
  const { data: paged, isLoading, isError } = useDeliveries({ pageSize: 5 })
  const { data: pipelines = [] } = usePipelines(undefined)

  const deliveries = paged?.items ?? []
  const runningCount = deliveries.filter(d => d.status === 'Running').length

  return (
    <div style={{ padding: 22, background: 'var(--axon-bg)', minHeight: '100%' }}>
      {/* Topbar */}
      <div
        style={{
          position: 'sticky', top: 0, zIndex: 10,
          margin: '-22px -22px 22px',
          padding: '0 22px',
          height: 50,
          background: 'var(--axon-bg2)',
          borderBottom: '1px solid var(--axon-border)',
          display: 'flex',
          alignItems: 'center',
          gap: 14,
        }}
      >
        <div style={{ flex: 1 }}>
          <div style={{ fontSize: 15, fontWeight: 600, color: 'var(--axon-t1)' }}>Dashboard</div>
          <div style={{ fontSize: 11, color: 'var(--axon-t3)', marginTop: 1 }}>Autonomous delivery platform</div>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          {runningCount > 0 && (
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 3, fontSize: 10, fontWeight: 600, padding: '2px 7px', borderRadius: 20, background: 'var(--axon-teal-d)', color: 'var(--axon-teal)', border: '1px solid rgba(34,211,184,0.2)' }}>
              <span style={{ width: 5, height: 5, borderRadius: '50%', background: 'var(--axon-teal)' }} />
              {runningCount} running
            </span>
          )}
          <button
            onClick={() => modal.open()}
            style={{
              display: 'inline-flex', alignItems: 'center', gap: 5,
              padding: '6px 13px', borderRadius: 8, fontSize: 12, fontWeight: 600,
              cursor: 'pointer', border: 'none', background: 'var(--axon-nexus)', color: '#fff',
              fontFamily: 'inherit',
            }}
          >
            + New Delivery
          </button>
        </div>
      </div>

      {/* Stat Cards */}
      <StatCards deliveries={deliveries} />

      {/* Row 2: Active Deliveries + Quick Launch */}
      <div className="grid gap-3.5 mb-3.5" style={{ gridTemplateColumns: '1fr 1fr' }}>
        <Card>
          <SectionHeader
            title="Active Deliveries"
            action={
              <button
                onClick={() => navigate('/deliveries')}
                style={{ padding: '5px 10px', borderRadius: 8, fontSize: 11, fontWeight: 600, cursor: 'pointer', border: '1px solid var(--axon-border2)', color: 'var(--axon-t2)', background: 'transparent', fontFamily: 'inherit' }}
              >
                View all →
              </button>
            }
          />
          <ActiveDeliveries
            deliveries={deliveries}
            isLoading={isLoading}
            isError={isError}
          />
        </Card>

        <Card>
          <SectionHeader title="Quick Launch" />
          <QuickLaunch pipelines={pipelines} onLaunch={modal.open} />
        </Card>
      </div>

      {/* Row 3: Recent Activity */}
      <Card>
        <SectionHeader title="Recent Activity" />
        <RecentActivity deliveries={deliveries} />
      </Card>

      <NewDeliveryModal
        isOpen={modal.isOpen}
        onClose={modal.close}
        defaultPipelineId={modal.defaultPipelineId}
      />
    </div>
  )
}
