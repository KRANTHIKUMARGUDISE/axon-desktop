import { useCallback, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '../ui/dialog'
import { Button } from '../ui/button'

export interface ConfirmOptions {
  title: string
  /** Body text; a ReactNode or plain string (line breaks are kept). */
  message?: ReactNode
  confirmLabel?: string
  cancelLabel?: string
  /** Red confirm button for actions that cannot be undone. */
  destructive?: boolean
}

/**
 * In-app replacement for window.confirm: `const [confirm, confirmDialog] = useConfirm()`, render `{confirmDialog}`
 * once, then `if (!(await confirm({ title, message }))) return`.
 */
export function useConfirm(): [(opts: ConfirmOptions) => Promise<boolean>, ReactNode] {
  const [opts, setOpts] = useState<ConfirmOptions | null>(null)
  const resolver = useRef<((ok: boolean) => void) | null>(null)

  const confirm = useCallback((o: ConfirmOptions) => new Promise<boolean>((resolve) => {
    resolver.current?.(false)
    resolver.current = resolve
    setOpts(o)
  }), [])

  const settle = (ok: boolean) => {
    resolver.current?.(ok)
    resolver.current = null
    setOpts(null)
  }

  const dialog = (
    <Dialog open={!!opts} onOpenChange={(o) => { if (!o) settle(false) }}>
      <DialogContent data-testid="confirm-dialog">
        <DialogHeader>
          <DialogTitle>{opts?.title}</DialogTitle>
          {opts?.message && (
            <DialogDescription style={{ whiteSpace: 'pre-line', overflowWrap: 'anywhere' }}>{opts.message}</DialogDescription>
          )}
        </DialogHeader>
        <DialogFooter>
          <Button variant="outline" onClick={() => settle(false)}>{opts?.cancelLabel ?? 'Cancel'}</Button>
          <Button variant={opts?.destructive ? 'destructive' : 'default'} onClick={() => settle(true)}>{opts?.confirmLabel ?? 'Confirm'}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
  return [confirm, dialog]
}
