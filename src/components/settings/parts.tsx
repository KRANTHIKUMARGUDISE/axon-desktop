import type { ReactNode } from 'react'
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle, CardAction } from '../ui/card'
import { Label } from '../ui/label'
import { Badge } from '../ui/badge'
import { Alert, AlertDescription } from '../ui/alert'
import { AlertCircle, CheckCircle2 } from 'lucide-react'

// Shared building blocks for the Settings screens (shadcn primitives only): every card has a header
// (title, description, optional status badge), labelled fields in one column, and a footer whose actions are
// right-aligned — so all sections line up the same way.

export function SettingsCard({
  title, description, status, footer, children,
}: {
  title: string
  description?: string
  status?: ReactNode
  footer?: ReactNode
  children: ReactNode
}) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>{title}</CardTitle>
        {description && <CardDescription>{description}</CardDescription>}
        {status && <CardAction>{status}</CardAction>}
      </CardHeader>
      <CardContent className="flex flex-col gap-5">{children}</CardContent>
      {footer && <CardFooter className="flex flex-wrap items-center justify-end gap-2">{footer}</CardFooter>}
    </Card>
  )
}

export function Field({
  label, htmlFor, hint, children,
}: {
  label: string
  htmlFor?: string
  hint?: ReactNode
  children: ReactNode
}) {
  return (
    <div className="flex flex-col gap-2">
      <Label htmlFor={htmlFor}>{label}</Label>
      {children}
      {hint && <p className="text-xs text-muted-foreground">{hint}</p>}
    </div>
  )
}

/** A read-only value: plain text (not an input), so it never looks editable. */
export function Info({ label, hint, mono, children }: { label: string; hint?: ReactNode; mono?: boolean; children: ReactNode }) {
  return (
    <div className="flex min-w-0 flex-col gap-1">
      <span className="text-sm font-medium text-muted-foreground">{label}</span>
      <span className={`truncate text-sm text-foreground ${mono ? 'font-mono' : ''}`}>{children || <span className="text-muted-foreground">Not set</span>}</span>
      {hint && <span className="text-xs text-muted-foreground">{hint}</span>}
    </div>
  )
}

/** Two or more fields side by side on wide screens, stacked on narrow ones. */
export function FieldRow({ children }: { children: ReactNode }) {
  return <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">{children}</div>
}

export function StatusBadge({ tone, children }: { tone: 'ok' | 'warn' | 'error' | 'muted'; children: ReactNode }) {
  const cls = {
    ok: 'border-emerald-500/40 text-emerald-500',
    warn: 'border-amber-500/40 text-amber-500',
    error: 'border-destructive/50 text-destructive',
    muted: 'text-muted-foreground',
  }[tone]
  return <Badge variant="outline" className={cls}>{children}</Badge>
}

export function Notice({ ok, children }: { ok: boolean; children: ReactNode }) {
  return (
    <Alert
      variant={ok ? 'default' : 'destructive'}
      className={ok ? 'border-emerald-500/40 bg-emerald-500/10 text-emerald-500 *:data-[slot=alert-description]:text-emerald-500' : undefined}
    >
      {ok ? <CheckCircle2 /> : <AlertCircle />}
      <AlertDescription>{children}</AlertDescription>
    </Alert>
  )
}

/** Strips Electron's "Error invoking remote method …" prefix so toasts/alerts show the actual reason. */
export function cleanError(e: unknown, fallback = 'Something went wrong'): string {
  return e instanceof Error ? e.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '') : fallback
}
