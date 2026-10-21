# Supabase Keep-Alive — Kasus & Instruksi untuk Agent

> **Untuk agent yang membaca file ini:** tugas Anda adalah memasang keep-alive Supabase di project
> ini. Baca file ini, lalu [`spec-supabase-keep-alive.md`](spec-supabase-keep-alive.md), lalu
> kerjakan [`plan-supabase-keep-alive.md`](plan-supabase-keep-alive.md) task demi task. Ketiga file ada di folder yang sama. Spec adalah acuan utama. Kalau plan dan kondisi project
> berbeda, ikuti spec dan catat keputusan Anda di ringkasan akhir.

## Kasusnya

Project ini memakai **Supabase free tier** sebagai backend dan di-deploy di **Vercel**.
Pengembangannya sering tertunda 2–3 bulan. Supabase mem-*pause* project free tier yang lama tidak
ada aktivitas database, jadi setiap kali mau lanjut, database harus di-restore manual dulu.

## Solusinya

Project ini menjaga dirinya sendiri:

```
Vercel Cron (setiap hari 00:00 UTC = 07:00 WIB)
   └─> GET /api/keep-alive          (dilindungi CRON_SECRET)
         └─> query ringan ke Supabase: select 1 baris dari tabel yang sudah ada
               ├─ berhasil → HTTP 200, log "keep-alive <project> ok <ms>ms"
               └─ gagal    → HTTP 500 (merah di Vercel Logs), log "keep-alive <project> FAIL <ms>ms <error>"
```

- **Tidak perlu SQL, tabel, atau migration baru.** Query membaca tabel yang sudah ada dengan
  anon key. Kalau RLS memblokir, hasilnya kosong, tapi query tetap dijalankan Postgres dan
  dihitung sebagai aktivitas.
- **Tidak menyentuh fitur aplikasi.** Hanya menambah satu endpoint, satu entri cron, dan satu
  env var.
- **Tidak ada notifikasi email.** Tidak semua project punya konfigurasi email, jadi kegagalan
  hanya terlihat di Vercel Logs.

## Cara pakai di project baru

1. Salin folder ini ke project, misalnya ke `docs/supabase-keep-alive/`.
2. Minta agent: *"Baca `docs/supabase-keep-alive/SUPABASE-KEEP-ALIVE.md` lalu implementasikan."*
3. Setelah agent selesai, set env var di Vercel (Production):

   | Var | Isi |
   |-----|-----|
   | `CRON_SECRET` | string acak: `openssl rand -hex 32` (beda per project) |
   | `KEEP_ALIVE_TABLE` | opsional, override tabel yang dipakai untuk ping |

   URL dan anon key Supabase **memakai env var yang sudah ada** di project
   (`NEXT_PUBLIC_SUPABASE_URL` / `VITE_SUPABASE_URL`, dst.).
4. Deploy ke production, lalu cek:
   ```bash
   curl -s -H "Authorization: Bearer <CRON_SECRET>" https://<domain>/api/keep-alive
   ```
   Hasilnya harus HTTP 200 dengan `"ok": true`.
5. **Uji gagal sekali:** sementara ubah `KEEP_ALIVE_TABLE` di env Vercel ke `tabel_tidak_ada`,
   redeploy, panggil curl di atas (hasilnya HTTP 500 dengan pesan `KEEP_ALIVE_TABLE`), pastikan
   baris `keep-alive ... FAIL` muncul di Vercel Logs, lalu hapus override itu dan redeploy.

## Cara cek keep-alive masih jalan

Karena tidak ada email, cek sesekali (misalnya sebelum lanjut mengerjakan project):

1. Vercel → project → **Settings → Cron Jobs**: `/api/keep-alive` masih terdaftar?
2. Vercel → **Deployments**: deployment production terakhir sukses?
3. Vercel → **Logs**: filter `/api/keep-alive`, lalu cari baris `keep-alive`. Ada `FAIL`,
   `CRASH`, atau status 500?
4. Jalankan curl di langkah 4 di atas.

## Batasan yang perlu diketahui

- Vercel Hobby: cron paling sering sekali sehari, dan waktunya bisa meleset sampai 1 jam. Cron
  hanya jalan di deployment **production**.
- Kegagalan tidak dikirim ke mana pun; hanya tercatat di Vercel Logs. Kalau tidak dicek, ping
  yang gagal bisa tidak ketahuan sampai project ter-pause.
- Kalau tabel yang dipakai untuk ping di-rename atau dihapus, ping akan gagal (HTTP 500).
  Perbaiki dengan mengubah `KEEP_ALIVE_TABLE` atau konstanta default di kode.
- Supabase tidak mempublikasikan definisi "tidak aktif" secara detail. Query baca lewat REST API
  adalah cara yang dipakai solusi komunitas. Kalau project tetap ter-pause, fallback-nya ada di
  spec (bagian *Open risk*).
