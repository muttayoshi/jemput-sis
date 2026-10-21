# jemput-sis

A realtime school pickup-call board. A staff member on duty (`/piket`) searches
for a student and calls them; the call appears immediately on a classroom
display (`/kelas`) filtered to that student's class, with sound and a
flap-drop animation, and expires automatically after a short active window.
An admin area (`/admin`) manages the student roster behind a simple
password-gated session.

## First-run setup

1. Create a Supabase project.
2. Run `supabase/schema.sql` in the Supabase SQL editor to create the
   `students` and `calls` tables, enable row-level security, and add `calls`
   to the `supabase_realtime` publication.
3. Copy `.env.local.example` to `.env.local` and fill in the values:
   - `NEXT_PUBLIC_SUPABASE_URL` and `NEXT_PUBLIC_SUPABASE_ANON_KEY` — from
     your Supabase project's API settings.
   - `SUPABASE_SERVICE_ROLE_KEY` — used server-side only, for admin student
     CRUD.
   - `ADMIN_PASSWORD` — the password for `/admin/login`.
   - `ADMIN_SESSION_SECRET` — a random secret used to sign the admin session
     cookie.
4. Add a `public/call-notification.mp3` notification sound file (not
   included in this repo).
5. `npm install`
6. `npm run dev`

## Tests and build

- `npm test` — run the test suite (Vitest).
- `npm run typecheck` — run the TypeScript compiler in check-only mode.
- `npm run build` — production build (Next.js).

## Supabase keep-alive

Supabase free tier mem-*pause* project yang lama tidak aktif. Vercel Cron memanggil
`/api/keep-alive` setiap hari pukul 00:00 UTC (07:00 WIB); endpoint ini menjalankan satu query
baca ke tabel `students` dengan anon key. Gagal → HTTP 500 dan baris `keep-alive jemput-sis FAIL ...`
di Vercel Logs (tidak ada notifikasi email).

- Env var di Vercel (Production): `CRON_SECRET` (wajib, `openssl rand -hex 32`),
  `KEEP_ALIVE_TABLE` (opsional, ganti tabel ping). URL dan anon key memakai
  `NEXT_PUBLIC_SUPABASE_URL` / `NEXT_PUBLIC_SUPABASE_ANON_KEY` yang sudah ada.
- Cek manual: `curl -s -H "Authorization: Bearer <CRON_SECRET>" https://<domain>/api/keep-alive`
  → HTTP 200 dengan `"ok": true`.
- Vercel → Logs, filter `/api/keep-alive`: cari `FAIL`, `CRASH`, atau status 500.

Detail: [docs/SUPABASE-KEEP-ALIVE.md](docs/SUPABASE-KEEP-ALIVE.md).
