import { ipcMain } from 'electron'
import type { IpcMainEvent, IpcMainInvokeEvent } from 'electron'
import type { z } from 'zod'
import { log } from '../log'

// Every ipcMain channel goes through handle()/on(): the sender must be the app's own top
// frame and the arguments must parse against a zod tuple schema.

let trusted: (url: string) => boolean = () => false

/** Called once from main.ts with the dev-server origin or the packaged index.html file URL. */
export function configureTrustedSender(fn: (url: string) => boolean): void {
  trusted = fn
}

export function makeTrustedUrlCheck(opts: { devOrigin?: string; fileUrl?: string }): (url: string) => boolean {
  return (url) => {
    if (opts.devOrigin && (url === opts.devOrigin || url.startsWith(`${opts.devOrigin}/`))) return true
    if (opts.fileUrl) {
      const base = opts.fileUrl.split('#')[0]
      if (url === base || url.startsWith(`${base}#`) || url.startsWith(`${base}?`)) return true
    }
    return false
  }
}

type AnyEvent = Pick<IpcMainInvokeEvent | IpcMainEvent, 'senderFrame' | 'sender'>

export function assertTrustedSender(channel: string, event: AnyEvent): void {
  const frame = event.senderFrame
  const url = frame?.url ?? ''
  const top = !!frame && frame === event.sender?.mainFrame
  if (!top || !trusted(url)) {
    log.warn(`[ipc] rejected ${channel} from untrusted sender`, { url, top })
    throw new Error('Untrusted IPC sender')
  }
}

function parseArgs<S extends z.ZodType>(channel: string, schema: S, args: unknown[]): z.infer<S> {
  const res = schema.safeParse(args)
  if (!res.success) {
    log.warn(`[ipc] invalid arguments for ${channel}`, res.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`))
    throw new Error(`Invalid arguments for ${channel}`)
  }
  return res.data
}

/** ipcMain.handle with sender check + zod tuple validation. `schema` validates the args array. */
export function handle<S extends z.ZodType>(
  channel: string,
  schema: S,
  fn: (args: z.infer<S>, event: IpcMainInvokeEvent) => unknown,
): void {
  ipcMain.handle(channel, (event, ...args) => {
    assertTrustedSender(channel, event)
    return fn(parseArgs(channel, schema, args), event)
  })
}

/** Fire-and-forget (ipcRenderer.send) variant. Invalid/untrusted messages are dropped. */
export function on<S extends z.ZodType>(
  channel: string,
  schema: S,
  fn: (args: z.infer<S>, event: IpcMainEvent) => void,
): void {
  ipcMain.on(channel, (event, ...args) => {
    try {
      assertTrustedSender(channel, event)
      fn(parseArgs(channel, schema, args), event)
    } catch {
      // already logged
    }
  })
}
