// @vitest-environment node
import { describe, it, expect, vi, afterEach } from 'vitest'
import {
  DEFAULT_TABLE,
  PROJECT_NAME,
  buildHeaders,
  handleKeepAlive,
  pingSupabase,
  resolveConfig,
  runKeepAlive,
  type KeepAliveConfig,
} from './keepAlive'

function base64url(value: unknown): string {
  return Buffer.from(JSON.stringify(value)).toString('base64url')
}

function fakeJwt(role: string): string {
  return `${base64url({ alg: 'HS256' })}.${base64url({ role })}.sig`
}

const ANON_JWT = fakeJwt('anon')
const SERVICE_JWT = fakeJwt('service_role')

const cfg: KeepAliveConfig = {
  project: PROJECT_NAME,
  url: 'https://x.supabase.co',
  key: ANON_JWT,
  table: 'students',
}

function respond(status: number, body: unknown = []) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

function fakeFetch(...responses: Array<Response | Error>) {
  const fn = vi.fn()
  for (const r of responses) {
    if (r instanceof Error) fn.mockRejectedValueOnce(r)
    else fn.mockResolvedValueOnce(r)
  }
  return fn as unknown as typeof fetch & ReturnType<typeof vi.fn>
}

describe('resolveConfig', () => {
  it('uses the first URL and anon key found, strips a trailing slash, and defaults the table', () => {
    const result = resolveConfig({
      NEXT_PUBLIC_SUPABASE_URL: 'https://next.supabase.co/',
      VITE_SUPABASE_URL: 'https://vite.supabase.co',
      NEXT_PUBLIC_SUPABASE_ANON_KEY: ANON_JWT,
      VITE_SUPABASE_ANON_KEY: 'other',
    })
    expect(result).toEqual({
      project: PROJECT_NAME,
      url: 'https://next.supabase.co',
      key: ANON_JWT,
      table: DEFAULT_TABLE,
    })
  })

  it('prefers SUPABASE_URL over the public variants', () => {
    const result = resolveConfig({
      SUPABASE_URL: 'https://server.supabase.co',
      NEXT_PUBLIC_SUPABASE_URL: 'https://next.supabase.co',
      SUPABASE_ANON_KEY: ANON_JWT,
    })
    expect(result).toMatchObject({ url: 'https://server.supabase.co' })
  })

  it('accepts a publishable key', () => {
    const result = resolveConfig({
      SUPABASE_URL: 'https://x.supabase.co',
      SUPABASE_PUBLISHABLE_KEY: 'sb_publishable_x',
    })
    expect(result).toMatchObject({ key: 'sb_publishable_x' })
  })

  it('uses KEEP_ALIVE_TABLE when set', () => {
    const result = resolveConfig({
      SUPABASE_URL: 'https://x.supabase.co',
      SUPABASE_ANON_KEY: ANON_JWT,
      KEEP_ALIVE_TABLE: 'calls',
    })
    expect(result).toMatchObject({ table: 'calls' })
  })

  it('uses the anon key even when a service-role key is present', () => {
    const result = resolveConfig({
      NEXT_PUBLIC_SUPABASE_URL: 'https://x.supabase.co',
      SUPABASE_SERVICE_ROLE_KEY: SERVICE_JWT,
      NEXT_PUBLIC_SUPABASE_ANON_KEY: ANON_JWT,
    })
    expect(result).toMatchObject({ key: ANON_JWT })
  })

  it('reports a missing URL', () => {
    const result = resolveConfig({ SUPABASE_ANON_KEY: ANON_JWT })
    expect(result).toEqual({ error: expect.stringContaining('Supabase URL') })
  })

  it('reports a missing key', () => {
    const result = resolveConfig({ SUPABASE_URL: 'https://x.supabase.co' })
    expect(result).toEqual({ error: expect.stringContaining('anon key') })
  })

  it('refuses a JWT whose role is not anon', () => {
    const result = resolveConfig({
      SUPABASE_URL: 'https://x.supabase.co',
      SUPABASE_ANON_KEY: SERVICE_JWT,
    })
    expect(result).toEqual({ error: expect.stringContaining('service_role') })
    expect(JSON.stringify(result)).not.toContain(SERVICE_JWT)
  })

  it('refuses an eyJ key that cannot be decoded', () => {
    const result = resolveConfig({
      SUPABASE_URL: 'https://x.supabase.co',
      SUPABASE_ANON_KEY: 'eyJnot-a-jwt',
    })
    expect(result).toHaveProperty('error')
  })
})

describe('buildHeaders', () => {
  it('sends a JWT as apikey and bearer token', () => {
    expect(buildHeaders(ANON_JWT)).toEqual({
      apikey: ANON_JWT,
      Authorization: `Bearer ${ANON_JWT}`,
    })
  })

  it('sends a publishable key only as apikey', () => {
    const headers = buildHeaders('sb_publishable_x')
    expect(headers).toEqual({ apikey: 'sb_publishable_x' })
    expect(headers).not.toHaveProperty('Authorization')
  })
})

describe('pingSupabase', () => {
  it('returns ok on 200 after a single GET to the table', async () => {
    const f = fakeFetch(respond(200))
    const result = await pingSupabase(cfg, { fetch: f, retryDelayMs: 0 })
    expect(result).toMatchObject({ ok: true, status: 200 })
    expect(f).toHaveBeenCalledTimes(1)
    const [url, init] = f.mock.calls[0]
    expect(url).toBe('https://x.supabase.co/rest/v1/students?select=*&limit=1')
    expect(init.method).toBe('GET')
  })

  it('retries once and succeeds', async () => {
    const f = fakeFetch(respond(500), respond(200))
    const result = await pingSupabase(cfg, { fetch: f, retryDelayMs: 0 })
    expect(result).toMatchObject({ ok: true, status: 200 })
    expect(f).toHaveBeenCalledTimes(2)
  })

  it('fails after two errors', async () => {
    const f = fakeFetch(respond(500), respond(500))
    const result = await pingSupabase(cfg, { fetch: f, retryDelayMs: 0 })
    expect(result).toMatchObject({ ok: false, status: 500, error: 'HTTP 500' })
    expect(f).toHaveBeenCalledTimes(2)
  })

  it('hints at KEEP_ALIVE_TABLE when the table does not exist', async () => {
    const f = fakeFetch(respond(404, { code: 'PGRST205' }), respond(404, { code: 'PGRST205' }))
    const result = await pingSupabase(cfg, { fetch: f, retryDelayMs: 0 })
    expect(result.ok).toBe(false)
    expect(result.error).toBe(
      'table "students" not found: set KEEP_ALIVE_TABLE to an existing public table'
    )
  })

  it('reports when the anon role cannot read the table', async () => {
    const f = fakeFetch(respond(401, { code: '42501' }), respond(401, { code: '42501' }))
    const result = await pingSupabase(cfg, { fetch: f, retryDelayMs: 0 })
    expect(result.error).toContain('anon role cannot read')
  })

  it('reports a rejected key', async () => {
    const f = fakeFetch(respond(401, { message: 'nope' }), respond(401, { message: 'nope' }))
    const result = await pingSupabase(cfg, { fetch: f, retryDelayMs: 0 })
    expect(result.error).toBe('key rejected (HTTP 401)')
  })

  it('includes the cause code when fetch throws', async () => {
    const err = () =>
      Object.assign(new TypeError('fetch failed'), { cause: { code: 'ENOTFOUND' } })
    const f = fakeFetch(err(), err())
    const result = await pingSupabase(cfg, { fetch: f, retryDelayMs: 0 })
    expect(result).toMatchObject({ ok: false, error: 'fetch failed (ENOTFOUND)' })
    expect(result.status).toBeUndefined()
  })

  it('times out a hanging request', async () => {
    const hanging = ((_url: string, init: RequestInit) =>
      new Promise((_resolve, reject) => {
        init.signal?.addEventListener('abort', () => reject(init.signal!.reason))
      })) as unknown as typeof fetch
    const result = await pingSupabase(cfg, { fetch: hanging, timeoutMs: 20, retryDelayMs: 0 })
    expect(result).toMatchObject({ ok: false, error: 'timeout after 20ms' })
  })

  it('never copies the key into the result, even when the body echoes it', async () => {
    const f = fakeFetch(respond(400, { message: ANON_JWT }), respond(400, { message: ANON_JWT }))
    const result = await pingSupabase(cfg, { fetch: f, retryDelayMs: 0 })
    expect(JSON.stringify(result)).not.toContain(ANON_JWT)
  })
})

describe('runKeepAlive', () => {
  const env = { NEXT_PUBLIC_SUPABASE_URL: 'https://x.supabase.co', NEXT_PUBLIC_SUPABASE_ANON_KEY: ANON_JWT }

  it('returns ok with project and table', async () => {
    const outcome = await runKeepAlive({ env, fetch: fakeFetch(respond(200)), retryDelayMs: 0 })
    expect(outcome).toMatchObject({ ok: true, project: PROJECT_NAME, table: DEFAULT_TABLE, status: 200 })
    expect(JSON.stringify(outcome)).not.toContain(ANON_JWT)
  })

  it('passes through a failed ping', async () => {
    const outcome = await runKeepAlive({
      env,
      fetch: fakeFetch(respond(503), respond(503)),
      retryDelayMs: 0,
    })
    expect(outcome).toMatchObject({ ok: false, status: 503, error: 'HTTP 503', table: DEFAULT_TABLE })
  })

  it('fails on a config error without calling Supabase', async () => {
    const f = fakeFetch()
    const outcome = await runKeepAlive({ env: { NEXT_PUBLIC_SUPABASE_ANON_KEY: ANON_JWT }, fetch: f })
    expect(outcome.ok).toBe(false)
    expect(outcome.error).toContain('Supabase URL')
    expect(outcome).not.toHaveProperty('table')
    expect(f).not.toHaveBeenCalled()
  })
})

describe('handleKeepAlive', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  const okRun = vi.fn(async () => ({ ok: true, project: PROJECT_NAME, table: 'students', status: 200, ms: 5 }))

  it('returns 500 when CRON_SECRET is not set', async () => {
    const run = vi.fn()
    const result = await handleKeepAlive({}, 'Bearer x', { run })
    expect(result).toEqual({ status: 500, body: { error: 'CRON_SECRET not set' } })
    expect(run).not.toHaveBeenCalled()
  })

  it.each([
    ['missing', undefined],
    ['wrong', 'Bearer wrong'],
    ['un-prefixed', 'secret'],
  ])('returns 401 for a %s secret', async (_label, header) => {
    const run = vi.fn()
    const result = await handleKeepAlive({ CRON_SECRET: 'secret' }, header, { run })
    expect(result).toEqual({ status: 401, body: { error: 'Unauthorized' } })
    expect(run).not.toHaveBeenCalled()
  })

  it('returns 200 and logs ok when the run succeeds', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    const result = await handleKeepAlive({ CRON_SECRET: 'secret' }, 'Bearer secret', { run: okRun })
    expect(result.status).toBe(200)
    expect(result.body).toMatchObject({ ok: true })
    expect(log).toHaveBeenCalledWith(`keep-alive ${PROJECT_NAME} ok 5ms`)
  })

  it('returns 500 and logs FAIL when the run fails', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    const run = vi.fn(async () => ({ ok: false, project: PROJECT_NAME, table: 'students', status: 503, error: 'HTTP 503', ms: 7 }))
    const result = await handleKeepAlive({ CRON_SECRET: 'secret' }, 'Bearer secret', { run })
    expect(result.status).toBe(500)
    expect(result.body).toMatchObject({ ok: false, error: 'HTTP 503' })
    expect(error).toHaveBeenCalledWith(`keep-alive ${PROJECT_NAME} FAIL 7ms HTTP 503`)
  })

  it('returns 500 crashed and logs CRASH when the run throws', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    const run = vi.fn(async () => {
      throw new Error('boom')
    })
    const result = await handleKeepAlive({ CRON_SECRET: 'secret' }, 'Bearer secret', { run })
    expect(result).toEqual({ status: 500, body: { error: 'crashed' } })
    expect(error).toHaveBeenCalledWith(`keep-alive ${PROJECT_NAME} CRASH boom`)
  })
})
