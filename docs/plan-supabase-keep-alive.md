# Supabase Keep-Alive Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans (or
> superpowers:subagent-driven-development) to implement this plan task-by-task. Steps use checkbox
> (`- [ ]`) syntax for tracking. Work on a branch, not on `main`.

**Goal:** A daily Vercel Cron call to `/api/keep-alive` that runs one read query against this project's Supabase database and returns HTTP 500 plus a `FAIL` log line when it fails. No email notifications.

**Architecture:** One framework-free module (`lib/keep-alive.ts`) with `env` and `fetch` injected, so it can be unit-tested; one thin route file per framework; one `crons` entry in `vercel.json`.

**Tech Stack:** the project's own TypeScript/JavaScript setup, global `fetch`, Vercel Cron, the project's test runner (Vitest if none).

**Spec:** `spec-supabase-keep-alive.md` (same folder). The spec wins over this plan when they disagree.

## Global Constraints

- No SQL, table, migration, function or RLS change in Supabase.
- Never use a service-role / secret key, even if one is in the env.
- No new runtime dependencies; do not use `@supabase/supabase-js` for the ping.
- Ping: `GET {url}/rest/v1/{table}?select=*&limit=1`; `apikey` header always; `Authorization: Bearer` only for `eyJ` keys.
- Timeout 10 000 ms per attempt, 1 retry after 1 000 ms.
- Cron: `{ "path": "/api/keep-alive", "schedule": "0 0 * * *" }`.
- No email or other notifications (no Resend, SMTP, webhooks). Failure = HTTP 500 + one `FAIL` log line.
- Keys never in logs or responses. Response bodies from Supabase are never copied into error text.
- Existing app behaviour is untouched.

## Review Focus

1. Supabase URL with a trailing slash (`https://x.supabase.co/`) must not produce `//rest/v1`. Test in Task 2.
2. The project has a service-role var **and** an anon var: the anon one is used; a JWT whose role is not `anon` is refused. Test in Task 2.
3. Table renamed / dropped (404 `PGRST205`) gives the `KEEP_ALIVE_TABLE` hint, not a bare 404. Test in Task 2.
4. Vite project with an SPA catch-all rewrite: `/api/keep-alive` must reach the function, not `index.html`. Verified in Task 4 Step 2.

---

### Task 1: Recon (no code)

Decide and write down the following. They go in the final summary and are used by later tasks.

- [ ] **Step 1: Project type.** Next.js App Router / Next.js Pages Router / Vite or other. Check `package.json` and the presence of `app/`, `src/app/`, `pages/`, `vite.config.*`.
- [ ] **Step 2: Supabase env var names.** `grep -rhoE "(NEXT_PUBLIC_|VITE_)?SUPABASE_[A-Z_]+" --include=*.{ts,tsx,js,jsx} . | sort -u` (exclude `node_modules`), plus `.env.example` if present. If the URL or anon/publishable key uses a name not in the spec's lists, add it to the lists in Task 2.
- [ ] **Step 3: Table.** Pick one existing `public` table from schema/migration files (`supabase/*.sql`, `supabase/migrations/`) or `.from('<table>')` calls. Prefer small and stable. If unsure, choose the table the app reads on its main page.
- [ ] **Step 4: Project name** for the log line and response: the `name` in `package.json`, otherwise the repo folder name.
- [ ] **Step 5: Test runner.** Use the existing one (`vitest`, `jest`). If none, install `vitest` as a dev dependency and add `"test": "vitest run"`.
- [ ] **Step 6: `vercel.json`.** Note whether it exists and whether it has a catch-all rewrite.

### Task 2: Ping + config (`lib/keep-alive.ts`, part 1)

**Files:**
- Create: `lib/keep-alive.ts` (use `src/lib/` if the project keeps code under `src/`; match existing path aliases)
- Test: next to the project's other tests, e.g. `lib/keep-alive.test.ts`

**Interfaces (produces):**
```ts
export type Env = Record<string, string | undefined>;
export interface KeepAliveConfig { project: string; url: string; key: string; table: string }
export interface PingResult { ok: boolean; status?: number; error?: string; ms: number }

export const PROJECT_NAME: string;   // from Task 1 Step 4
export const DEFAULT_TABLE: string;  // from Task 1 Step 3

export function resolveConfig(env: Env): KeepAliveConfig | { error: string };
export function buildHeaders(key: string): Record<string, string>;
export function pingSupabase(
  cfg: KeepAliveConfig,
  opts?: { fetch?: typeof fetch; timeoutMs?: number; retryDelayMs?: number },
): Promise<PingResult>; // never throws
```

- [ ] **Step 1: Write failing tests.** Fake JWTs are built in the test as `base64url({alg:'HS256'}) + '.' + base64url({role}) + '.sig'`.
  - `resolveConfig` picks the URL and the anon or publishable var in the spec's order (first found of `SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_URL`, `VITE_SUPABASE_URL`, …); strips a trailing `/` from the URL; `table` = `KEEP_ALIVE_TABLE` ?? `DEFAULT_TABLE`.
  - With both `SUPABASE_SERVICE_ROLE_KEY` and an anon var set → uses the anon value.
  - URL missing → `{ error }` containing `Supabase URL`; key missing → `{ error }` containing `anon key`.
  - Key JWT with role `service_role` → `{ error }` containing `service_role`; `eyJ` key that is not decodable → `{ error }`.
  - `buildHeaders('eyJ…')` has `apikey` and `Authorization: Bearer …`; `buildHeaders('sb_publishable_x')` has `apikey` and no `Authorization`.
  - `pingSupabase`: 200 → `{ ok: true, status: 200 }`, one call to `https://x.supabase.co/rest/v1/<table>?select=*&limit=1`, method GET.
  - 500 then 200 → ok, two calls. Two 500s → `{ ok: false, status: 500 }`.
  - 404 body `{"code":"PGRST205"}` → error contains `KEEP_ALIVE_TABLE`.
  - 401 body `{"code":"42501"}` → error contains `anon role cannot read`. Plain 401 → `key rejected (HTTP 401)`.
  - fetch rejects `Object.assign(new TypeError('fetch failed'), { cause: { code: 'ENOTFOUND' } })` → error `fetch failed (ENOTFOUND)`.
  - Hanging fetch with `timeoutMs: 20` → error `timeout after 20ms`.
  - Result JSON never contains the key, even when the response body echoes it.
- [ ] **Step 2: Run the tests.** Expected: FAIL (module missing).
- [ ] **Step 3: Implement.** Timeout via `AbortSignal.timeout`; error texts exactly as in the spec table.
- [ ] **Step 4: Run tests and typecheck.** Expected: PASS.
- [ ] **Step 5: Commit** `feat: supabase keep-alive ping`.

### Task 3: Run (`lib/keep-alive.ts`, part 2)

**Interfaces (consumes Task 2; produces):**
```ts
export interface RunOutcome extends PingResult { project: string; table?: string }
export function runKeepAlive(deps: { env: Env; fetch?: typeof fetch; retryDelayMs?: number }): Promise<RunOutcome>; // never throws
```

- [ ] **Step 1: Write failing tests** (fake fetch):
  - Ping ok → `{ ok: true, project, table, status: 200 }`.
  - Ping fails → `ok: false` with the ping's `error` and `status`.
  - Config error (no URL) → `ok: false`, `error` set, Supabase never called.
  - Outcome JSON never contains the Supabase key.
- [ ] **Step 2: Run.** Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run tests and typecheck.** Expected: PASS.
- [ ] **Step 5: Commit** `feat: supabase keep-alive run`.

### Task 4: Route + cron + docs

**Files:**
- Create: the route file for this project type (spec, *Where code goes*)
- Create/Modify: `vercel.json`
- Modify: `README.md` (short section)
- Test: route/handler test next to the others

**Interfaces (consumes):** `runKeepAlive`. Put auth in a pure helper in `lib/keep-alive.ts`:
`export function handleKeepAlive(env: Env, authorization: string | null | undefined, deps?: { run?: typeof runKeepAlive }): Promise<{ status: number; body: unknown }>`. The route file only maps the request to this helper and back.

- [ ] **Step 1: Write failing tests for `handleKeepAlive`:** 500 `CRON_SECRET not set`; 401 for missing, wrong, and un-prefixed secret (run not called); 200 when run returns ok; 500 when run fails; run throws → 500 `{ error: 'crashed' }` and a `CRASH` log line. Run them: FAIL. Implement (constant-time compare via `crypto.timingSafeEqual` with a length check; one log line per spec). Run: PASS.
- [ ] **Step 2: Route file + `vercel.json`.** Add the `crons` entry (merge, keep existing keys). Vite: add `functions.maxDuration` and make sure any catch-all rewrite excludes `/api/`. Next.js App Router: `dynamic = 'force-dynamic'`, `maxDuration = 60`.
- [ ] **Step 3: Verify.** Run the full test suite, typecheck, and the project's build (`npm run build`). Expected: all green, no app files changed besides those listed. Then call the route locally with real env if available (`npm run dev` / `vercel dev` and `curl -H "Authorization: Bearer $CRON_SECRET" localhost:<port>/api/keep-alive`). Expected: 200 `"ok": true`. If no local env, say so in the summary.
- [ ] **Step 4: README section** "Supabase keep-alive" (Bahasa Indonesia, ≤ 15 lines): what it does, the env vars to set in Vercel (`CRON_SECRET`, optional `KEEP_ALIVE_TABLE`), the curl check, where to look in Vercel Logs, and a link to `docs/supabase-keep-alive/SUPABASE-KEEP-ALIVE.md`.
- [ ] **Step 5: Commit** `feat: daily Vercel cron to keep Supabase active`.

### Final summary to Abdu

Report: project type, Supabase env vars used, table chosen and why, test/build results, anything not verified (e.g. no local env), and the remaining manual steps from `SUPABASE-KEEP-ALIVE.md` (set env vars in Vercel, deploy, curl check, deliberate failure test).
