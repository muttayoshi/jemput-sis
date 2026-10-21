# Supabase Keep-Alive — Spec

Reusable spec: the same document is copied into every project that needs it. "This project"
means the project it has been copied into.

## Intent

Abdu's projects run on **Vercel + Supabase free tier**, mostly React + Vite, many Next.js.
Development often stalls for 2–3 months, Supabase pauses the inactive free-tier project, and the
database must be restored by hand before work can resume. Each project should keep its own
Supabase project active with a daily Vercel Cron call, and make a failure visible in Vercel logs.

A central "pinger" service was tried and rejected: it still required a SQL change in every project
and a separate service to maintain. This spec is **self-contained per project** and must need
**no SQL, no new table, no migration**.

## Goals

1. Once per day, this project's Supabase database executes a real query triggered by Vercel Cron.
2. On failure, return a non-2xx response and log one line naming the project and the reason.
3. The endpoint is callable manually for testing, but returns 401 to anyone without the secret.

## Non-goals

- Email or any other notification. Not every project has email configured; failures are visible
  only in Vercel logs.
- Uptime monitoring of the website, dashboards, ping history.
- Restoring an already-paused project.
- Pinging other Supabase projects than this project's own.

## Anti-goals (count as failure even if it "works")

- Any SQL, migration, table, function or RLS policy change in Supabase.
- Using the `service_role` / secret key, even if the project already has one in its env
  (e.g. `SUPABASE_SERVICE_ROLE_KEY`). Only the anon / publishable key is used.
- Keys appearing in logs or HTTP responses.
- Silent failure: a failed ping must produce a non-2xx response (so it shows red in Vercel logs)
  **and** a `FAIL` log line.
- Changing application features or existing behaviour of the app.
- Adding email or other notification dependencies (Resend, SMTP, webhooks).

## Constraints

- Vercel Hobby: cron at most once a day, up to 1 hour of timing drift, production deployments
  only, schedule in UTC.
- Schedule: `0 0 * * *` (00:00 UTC = 07:00 WIB).
- No new runtime dependencies. Use global `fetch` (Node 18+). Do not require `@supabase/supabase-js`
  even if the project already has it.
- Adding a dev dependency for tests (`vitest`) is allowed only if the project has no test runner.

## Design

### How the ping works

`GET {SUPABASE_URL}/rest/v1/{table}?select=*&limit=1` with headers:

- `apikey: <key>` always;
- `Authorization: Bearer <key>` **only** if the key is a legacy JWT (starts with `eyJ`).
  Publishable keys (`sb_publishable_...`) are not JWTs and go only in `apikey`.

`{table}` is an **existing table in the `public` schema** of this project, picked during
implementation (small and stable, e.g. a lookup or settings table). It is a constant in code,
overridable by env `KEEP_ALIVE_TABLE`. An RLS-protected table is fine: PostgREST runs the query
and returns `200 []`. Success = any HTTP 2xx.

Timeout **10 s** per attempt, **one retry** after 1 s.

Error text (never includes response bodies, which could echo keys):

| Response | `error` text |
|----------|--------------|
| 404 with body code `PGRST205` / `42P01` | `table "<table>" not found: set KEEP_ALIVE_TABLE to an existing public table` |
| 401 / 403 with body code `42501` | `anon role cannot read "<table>": pick another table via KEEP_ALIVE_TABLE` |
| other 401 / 403 | `key rejected (HTTP <status>)` |
| other non-2xx | `HTTP <status>` |
| timeout | `timeout after 10000ms` |
| fetch throws | the error message plus `cause.code` if present (e.g. `fetch failed (ENOTFOUND)`) |

### Configuration

Read from `process.env` at request time:

| Var | Source |
|-----|--------|
| Supabase URL | the project's **existing** var, first found of: `SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_URL`, `VITE_SUPABASE_URL` |
| Supabase key | first found of: `SUPABASE_ANON_KEY`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`, `VITE_SUPABASE_ANON_KEY`, `SUPABASE_PUBLISHABLE_KEY`, `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY`, `VITE_SUPABASE_PUBLISHABLE_KEY`. Adjust the list during implementation if this project uses another name. **Never** a service-role / secret var. |
| `KEEP_ALIVE_TABLE` | optional override of the table constant |
| `CRON_SECRET` | required; Vercel sends `Authorization: Bearer <CRON_SECRET>` on cron calls |

`<project>` is a constant set during implementation (the repo / package name), used in the log
line and the response.

Missing URL or key, or a key that is a JWT whose payload `role` is not `anon`, is a failure
(reported like a failed ping, without calling Supabase).

### Run flow

1. `CRON_SECRET` unset → 500 `{ "error": "CRON_SECRET not set" }`. Header ≠
   `Bearer <CRON_SECRET>` (constant-time compare) → 401 `{ "error": "Unauthorized" }`.
2. Resolve config, ping.
3. Response JSON `{ ok, project, table?, status?, error?, ms }` (`table` is absent only on a config
   error). HTTP 200 if `ok`, else 500.
4. Log one line: `keep-alive <project> ok|FAIL <ms>ms [error]`. Never log keys.
5. Unexpected exception → log `keep-alive <project> CRASH <message>`, return 500
   `{ "error": "crashed" }`.

### Where code goes (by framework)

Logic lives in one framework-free module with `fetch` and `env` injected (unit-testable);
the route file is a thin adapter.

| Project type | Logic module | Route |
|--------------|--------------|-------|
| Next.js App Router | `lib/keep-alive.ts` (or `src/lib/…` if the project uses `src/`) | `app/api/keep-alive/route.ts` exporting `GET`, with `export const dynamic = 'force-dynamic'` and `export const maxDuration = 60` |
| Next.js Pages Router | same | `pages/api/keep-alive.ts` (default `(req, res)` handler) |
| Vite / other | `lib/keep-alive.ts` (root, outside the Vite bundle) | root `api/keep-alive.ts` exporting `GET(request: Request): Promise<Response>` (Vercel Web-standard function) |

`vercel.json` (create if missing, merge if present; keep existing keys):

```json
{ "crons": [{ "path": "/api/keep-alive", "schedule": "0 0 * * *" }] }
```

For Vite, also `"functions": { "api/keep-alive.ts": { "maxDuration": 60 } }`. If `vercel.json` has an
SPA catch-all rewrite, make sure `/api/` is excluded (e.g. source `/((?!api/).*)`).

## Left to the implementer

- Which table to use (record the choice and why in the final summary).
- File names inside the structure above, matching the project's conventions (TS vs JS, path aliases).

## Open risk

Supabase does not publish exactly what counts as activity. A read query through the REST API
executes in Postgres, which is what community keep-alive setups rely on. If a project still gets
paused, the fallback (and only then) is a write: that needs a small table and therefore a SQL
change, which this spec otherwise forbids. Raise it with Abdu instead of doing it unasked.
