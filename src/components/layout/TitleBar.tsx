import axonTitle from '../../assets/axon-title.png'

export function TitleBar() {
  return (
    <div
      className="titlebar-drag flex items-center shrink-0 border-b"
      style={{
        height: 44,
        paddingLeft: 16,
        background: 'var(--axon-bg2)',
        borderColor: 'var(--axon-border)',
      }}
    >
      <img src={axonTitle} alt="AXON" className="h-4 shrink-0" />
    </div>
  )
}
