import { describe, it, expect, vi } from 'vitest'
import { callClaude } from '../claudePrompt'
import { normalizeAgentOutput, buildInputFieldsText } from '../output'

const okResponse = (text: string) =>
  new Response(JSON.stringify({ content: [{ type: 'text', text }] }), { status: 200 })
const rateLimited = (retryAfter?: string) =>
  new Response('slow down', { status: 429, headers: retryAfter ? { 'retry-after': retryAfter } : {} })

describe('callClaude (Prompt mode)', () => {
  const opts = { timeoutSeconds: 30 }

  it('retries 429 honouring retry-after, then succeeds', async () => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(rateLimited('7'))
      .mockResolvedValueOnce(okResponse('hello'))
    const sleep = vi.fn().mockResolvedValue(undefined)
    const text = await callClaude('key', 's', 'u', opts, { fetchImpl, sleep, random: () => 0 })
    expect(text).toBe('hello')
    expect(fetchImpl).toHaveBeenCalledTimes(2)
    expect(sleep.mock.calls[0][0]).toBe(7000)
  })

  it('falls back to exponential backoff without retry-after', async () => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(rateLimited())
      .mockResolvedValueOnce(rateLimited())
      .mockResolvedValueOnce(okResponse('x'))
    const sleep = vi.fn().mockResolvedValue(undefined)
    await callClaude('key', 's', 'u', opts, { fetchImpl, sleep, random: () => 0 })
    expect(sleep.mock.calls.map((c) => c[0])).toEqual([1000, 2000])
  })

  it('gives up after a bounded number of 429s', async () => {
    const fetchImpl = vi.fn(async () => rateLimited('1'))
    const sleep = vi.fn().mockResolvedValue(undefined)
    await expect(callClaude('key', 's', 'u', opts, { fetchImpl, sleep, random: () => 0 })).rejects.toThrow(/retries exhausted/)
    expect(fetchImpl).toHaveBeenCalledTimes(4) // 1 try + 3 retries
  })

  it('caps an absurd retry-after', async () => {
    const fetchImpl = vi.fn().mockResolvedValueOnce(rateLimited('99999')).mockResolvedValueOnce(okResponse('x'))
    const sleep = vi.fn().mockResolvedValue(undefined)
    await callClaude('key', 's', 'u', opts, { fetchImpl, sleep, random: () => 0 })
    expect(sleep.mock.calls[0][0]).toBe(60_000)
  })

  it('reports cancellation when the external signal aborts the request', async () => {
    const ctrl = new AbortController()
    const fetchImpl = vi.fn((_url: unknown, init?: RequestInit) => new Promise<Response>((_res, rej) => {
      init?.signal?.addEventListener('abort', () => rej(new Error('aborted')))
    }))
    const p = callClaude('key', 's', 'u', { timeoutSeconds: 30, signal: ctrl.signal }, { fetchImpl: fetchImpl as unknown as typeof fetch })
    ctrl.abort()
    await expect(p).rejects.toThrow('Cancelled')
  })

  it('times out a hung request', async () => {
    const fetchImpl = vi.fn((_url: unknown, init?: RequestInit) => new Promise<Response>((_res, rej) => {
      init?.signal?.addEventListener('abort', () => rej(new Error('aborted')))
    }))
    await expect(
      callClaude('key', 's', 'u', { timeoutSeconds: 0.05 }, { fetchImpl: fetchImpl as unknown as typeof fetch }),
    ).rejects.toThrow(/timed out/)
  })

  it('maps 401 to a clear key error and requires a key', async () => {
    const fetchImpl = vi.fn(async () => new Response('', { status: 401 }))
    await expect(callClaude('bad', 's', 'u', opts, { fetchImpl })).rejects.toThrow('Invalid Claude API key')
    await expect(callClaude('', 's', 'u', opts, { fetchImpl })).rejects.toThrow(/not configured/)
  })
})

describe('normalizeAgentOutput', () => {
  it('parses fenced JSON and surrounding prose', () => {
    const out = normalizeAgentOutput('Sure!\n```json\n{"status":"success","summary":"ok","result":{"a":1}}\n```')
    expect(out).toMatchObject({ status: 'success', summary: 'ok', result: { a: 1 } })
  })

  it('fails on unparseable text and on an invalid status', () => {
    expect(normalizeAgentOutput('not json').status).toBe('failed')
    expect(normalizeAgentOutput('{"status":"maybe"}').status).toBe('failed')
  })

  it('applies outputMapping to resolve a non-canonical status', () => {
    const out = normalizeAgentOutput('{"outcome":{"state":"success"},"result":{}}', { status: 'outcome.state' })
    expect(out.status).toBe('success')
  })
})

describe('buildInputFieldsText', () => {
  const pool = { a: 1, b: 'two', c: [3] }
  it('selects only declared fields', () => {
    expect(buildInputFieldsText(pool, ['a', 'c'])).toBe('<untrusted_field name="a">1</untrusted_field>\n<untrusted_field name="c">[3]</untrusted_field>')
  })
  it('flags declared-but-missing fields', () => {
    expect(buildInputFieldsText(pool, ['zzz'])).toMatch(/none of the required fields \[zzz\]/)
  })
  it('includes nothing when nothing is declared (Selective is the default, review B1)', () => {
    expect(buildInputFieldsText(pool, [])).not.toContain('b: "two"')
  })
  it('includes the whole pool only when contextMode is Full', () => {
    expect(buildInputFieldsText(pool, [], 'Full')).toContain('<untrusted_field name="b">"two"</untrusted_field>')
  })
})
