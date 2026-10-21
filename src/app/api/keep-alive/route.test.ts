// @vitest-environment node
import { describe, it, expect, afterEach, vi } from 'vitest'
import { GET } from './route'

describe('GET /api/keep-alive', () => {
  afterEach(() => {
    vi.unstubAllEnvs()
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  it('returns 401 without the cron secret', async () => {
    vi.stubEnv('CRON_SECRET', 'secret')
    const res = await GET(new Request('http://localhost/api/keep-alive'))
    expect(res.status).toBe(401)
    expect(await res.json()).toEqual({ error: 'Unauthorized' })
  })

  it('pings Supabase and returns 200 with the cron secret', async () => {
    vi.stubEnv('CRON_SECRET', 'secret')
    vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', 'https://x.supabase.co')
    vi.stubEnv('NEXT_PUBLIC_SUPABASE_ANON_KEY', 'sb_publishable_x')
    const fetchMock = vi.fn(async () => new Response('[]', { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)
    vi.spyOn(console, 'log').mockImplementation(() => {})

    const res = await GET(
      new Request('http://localhost/api/keep-alive', {
        headers: { Authorization: 'Bearer secret' },
      })
    )

    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ ok: true, project: 'jemput-sis', table: 'students' })
    expect(fetchMock).toHaveBeenCalledWith(
      'https://x.supabase.co/rest/v1/students?select=*&limit=1',
      expect.objectContaining({ method: 'GET' })
    )
  })
})
