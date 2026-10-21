import { timingSafeEqual } from 'node:crypto'

// Daily Supabase keep-alive, called by Vercel Cron via /api/keep-alive.
// See docs/SUPABASE-KEEP-ALIVE.md. Uses only the anon key and a read query:
// no SQL, tables or service-role key involved.

export type Env = Record<string, string | undefined>

export interface KeepAliveConfig {
  project: string
  url: string
  key: string
  table: string
}

export interface PingResult {
  ok: boolean
  status?: number
  error?: string
  ms: number
}

export interface RunOutcome extends PingResult {
  project: string
  table?: string
}

export const PROJECT_NAME = 'jemput-sis'

// Small, stable, and readable by anon (see supabase/schema.sql).
export const DEFAULT_TABLE = 'students'

const URL_VARS = ['SUPABASE_URL', 'NEXT_PUBLIC_SUPABASE_URL', 'VITE_SUPABASE_URL']

// Anon / publishable keys only. Never add a service-role or secret var here.
const KEY_VARS = [
  'SUPABASE_ANON_KEY',
  'NEXT_PUBLIC_SUPABASE_ANON_KEY',
  'VITE_SUPABASE_ANON_KEY',
  'SUPABASE_PUBLISHABLE_KEY',
  'NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY',
  'VITE_SUPABASE_PUBLISHABLE_KEY',
]

const TIMEOUT_MS = 10_000
const RETRY_DELAY_MS = 1_000

function firstSet(env: Env, names: string[]): string | undefined {
  for (const name of names) {
    const value = env[name]?.trim()
    if (value) return value
  }
  return undefined
}

function isJwt(key: string): boolean {
  return key.startsWith('eyJ')
}

function jwtRole(key: string): string | undefined {
  try {
    const payload = key.split('.')[1]
    if (!payload) return undefined
    const role = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'))?.role
    return typeof role === 'string' ? role : undefined
  } catch {
    return undefined
  }
}

export function resolveConfig(env: Env): KeepAliveConfig | { error: string } {
  const url = firstSet(env, URL_VARS)
  if (!url) return { error: `Supabase URL not set (${URL_VARS.join(' / ')})` }

  const key = firstSet(env, KEY_VARS)
  if (!key) return { error: `Supabase anon key not set (${KEY_VARS.join(' / ')})` }

  if (isJwt(key)) {
    const role = jwtRole(key)
    if (!role) return { error: 'Supabase key looks like a JWT but cannot be decoded' }
    if (role !== 'anon') return { error: `Supabase key has role "${role}", expected anon` }
  }

  return {
    project: PROJECT_NAME,
    url: url.replace(/\/+$/, ''),
    key,
    table: env.KEEP_ALIVE_TABLE?.trim() || DEFAULT_TABLE,
  }
}

export function buildHeaders(key: string): Record<string, string> {
  return isJwt(key) ? { apikey: key, Authorization: `Bearer ${key}` } : { apikey: key }
}

async function readErrorCode(res: Response): Promise<string | undefined> {
  try {
    const code = (await res.json())?.code
    return typeof code === 'string' ? code : undefined
  } catch {
    return undefined
  }
}

// Error text never includes the response body, which could echo the key.
async function describeFailure(res: Response, table: string): Promise<string> {
  const code = await readErrorCode(res)
  if (res.status === 404 && (code === 'PGRST205' || code === '42P01')) {
    return `table "${table}" not found: set KEEP_ALIVE_TABLE to an existing public table`
  }
  if (res.status === 401 || res.status === 403) {
    if (code === '42501') return `anon role cannot read "${table}": pick another table via KEEP_ALIVE_TABLE`
    return `key rejected (HTTP ${res.status})`
  }
  return `HTTP ${res.status}`
}

async function attempt(
  cfg: KeepAliveConfig,
  fetchFn: typeof fetch,
  timeoutMs: number
): Promise<Omit<PingResult, 'ms'>> {
  const signal = AbortSignal.timeout(timeoutMs)
  try {
    const res = await fetchFn(`${cfg.url}/rest/v1/${cfg.table}?select=*&limit=1`, {
      method: 'GET',
      headers: buildHeaders(cfg.key),
      signal,
      cache: 'no-store',
    })
    if (res.ok) return { ok: true, status: res.status }
    return { ok: false, status: res.status, error: await describeFailure(res, cfg.table) }
  } catch (err) {
    if (signal.aborted) return { ok: false, error: `timeout after ${timeoutMs}ms` }
    const message = err instanceof Error ? err.message : String(err)
    const code = (err as { cause?: { code?: unknown } })?.cause?.code
    return { ok: false, error: typeof code === 'string' ? `${message} (${code})` : message }
  }
}

export async function pingSupabase(
  cfg: KeepAliveConfig,
  opts: { fetch?: typeof fetch; timeoutMs?: number; retryDelayMs?: number } = {}
): Promise<PingResult> {
  const fetchFn = opts.fetch ?? fetch
  const timeoutMs = opts.timeoutMs ?? TIMEOUT_MS
  const retryDelayMs = opts.retryDelayMs ?? RETRY_DELAY_MS
  const started = Date.now()

  let result = await attempt(cfg, fetchFn, timeoutMs)
  if (!result.ok) {
    await new Promise((resolve) => setTimeout(resolve, retryDelayMs))
    result = await attempt(cfg, fetchFn, timeoutMs)
  }

  return { ...result, ms: Date.now() - started }
}

export async function runKeepAlive(deps: {
  env: Env
  fetch?: typeof fetch
  retryDelayMs?: number
}): Promise<RunOutcome> {
  const started = Date.now()
  try {
    const cfg = resolveConfig(deps.env)
    if ('error' in cfg) {
      return { ok: false, project: PROJECT_NAME, error: cfg.error, ms: Date.now() - started }
    }
    const result = await pingSupabase(cfg, { fetch: deps.fetch, retryDelayMs: deps.retryDelayMs })
    return { ...result, project: PROJECT_NAME, table: cfg.table }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    return { ok: false, project: PROJECT_NAME, error: message, ms: Date.now() - started }
  }
}

function isAuthorized(authorization: string | null | undefined, secret: string): boolean {
  if (!authorization) return false
  const given = Buffer.from(authorization)
  const expected = Buffer.from(`Bearer ${secret}`)
  if (given.length !== expected.length) return false
  return timingSafeEqual(given, expected)
}

export async function handleKeepAlive(
  env: Env,
  authorization: string | null | undefined,
  deps: { run?: typeof runKeepAlive } = {}
): Promise<{ status: number; body: unknown }> {
  const secret = env.CRON_SECRET
  if (!secret) return { status: 500, body: { error: 'CRON_SECRET not set' } }
  if (!isAuthorized(authorization, secret)) return { status: 401, body: { error: 'Unauthorized' } }

  const run = deps.run ?? runKeepAlive
  try {
    const outcome = await run({ env })
    if (outcome.ok) {
      console.log(`keep-alive ${outcome.project} ok ${outcome.ms}ms`)
      return { status: 200, body: outcome }
    }
    console.error(`keep-alive ${outcome.project} FAIL ${outcome.ms}ms ${outcome.error}`)
    return { status: 500, body: outcome }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    console.error(`keep-alive ${PROJECT_NAME} CRASH ${message}`)
    return { status: 500, body: { error: 'crashed' } }
  }
}
