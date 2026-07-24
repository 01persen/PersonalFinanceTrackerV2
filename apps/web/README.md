# pft-web

Frontend Personal Finance Tracker — Next.js (App Router) + TypeScript + Tailwind
CSS.

Bagian dari sub-issue `sub-0001-04`: inisialisasi frontend + auth UI + guard.

## Stack

- **Next.js 14** (App Router, React 18).
- **TypeScript** (strict mode).
- **Tailwind CSS** untuk styling.
- **ESLint** + `next lint` + `tsc --noEmit` untuk quality gate.

## Setup

Prasyarat: Node ≥ 18.18 dan `pnpm` (lihat catatan di bawah bila `pnpm` tidak
ter-install).

```bash
cd apps/web
pnpm install
cp .env.example .env.local     # opsional; default sudah指向 localhost:8000
pnpm dev                       # jalan di http://localhost:3000
```

Backend FastAPI harus jalan di `http://localhost:8000` (lihat `apps/api`). CORS
sudah di-open untuk `http://localhost:3000` di konfigurasi backend.

### Catatan `pnpm`

Dokumentasi menggunakan `pnpm`. Bila environment tidak punya `pnpm`, alternatif:

```bash
npm install
npm run dev
```

Skrip `dev`, `build`, `start`, `lint`, `typecheck` memakai nama generik sehingga
siap dijalankan via npm/pnpm/yarn.

## Skrip

| Perintah        | Fungsi                                |
|-----------------|---------------------------------------|
| `pnpm dev`      | Next.js dev server (port 3000).       |
| `pnpm build`    | Production build.                     |
| `pnpm start`    | Jalankan hasil build.                 |
| `pnpm lint`     | `next lint` (ESLint).                 |
| `pnpm typecheck`| `tsc --noEmit` untuk type-check.      |

## Struktur

```
src/
├── app/
│   ├── globals.css       # Tailwind base + component classes
│   ├── layout.tsx        # Root layout, mount <AppProviders>
│   ├── providers.tsx     # Client-only wrapper untuk AuthProvider
│   ├── page.tsx          # Halaman utama (private, dibungkus AuthGuard)
│   ├── login/page.tsx    # Form login
│   └── register/page.tsx # Form daftar
└── lib/
    ├── env.ts            # API base URL + key storage
    ├── api/client.ts     # fetch wrapper + endpoints auth
    └── auth/
        ├── auth-context.tsx  # Context + provider (login/register/logout/me)
        ├── auth-guard.tsx    # Redirect ke /login saat belum auth
        └── guest-only.tsx    # Redirect ke / saat sudah auth
```

## Alur Auth

1. **Bootstrap** — saat aplikasi mount, `AuthProvider` cek access token di
   `localStorage`. Kalau ada, panggil `GET /api/v1/auth/me`. Sukses → state
   `authenticated`. Gagal (401/expired) → bersihkan token, state `unauthenticated`.
2. **Login/Register** — POST ke `/api/v1/auth/login` atau
   `/api/v1/auth/register`, simpan `access_token` + `refresh_token`, lalu
   panggil `/me` untuk dapat profil. Sukses → redirect ke `/`.
3. **Logout** — panggil `/api/v1/auth/logout` (stateless, balas 204), bersihkan
   token di `localStorage`, redirect ke `/login`.
4. **Guard** — `AuthGuard` membungkus route private; `GuestOnly` membungkus
   `/login` & `/register` agar user yang sudah login skip form.

## Kontrak API (sub-0001-03)

Lihat `apps/api/src/app/api/v1/auth.py` untuk definisi pasti. Ringkasan:

| Method | Path                    | Body / Response                                |
|--------|-------------------------|------------------------------------------------|
| POST   | `/api/v1/auth/register` | `{email, password}` → `TokenPair`              |
| POST   | `/api/v1/auth/login`    | `{email, password}` → `TokenPair`              |
| POST   | `/api/v1/auth/refresh`  | `{refresh_token}` → `AccessToken`              |
| POST   | `/api/v1/auth/logout`   | Bearer → 204                                   |
| GET    | `/api/v1/auth/me`       | Bearer → `UserPublic`                          |

Refresh otomatis (silent retry saat access expired) dipasang di epic berikutnya
— saat ini jika bootstrap `/me` gagal, token di-drop dan UI bounce ke `/login`.
