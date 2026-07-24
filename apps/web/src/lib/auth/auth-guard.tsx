"use client";

import { useRouter } from "next/navigation";
import { useEffect, type ReactNode } from "react";

import { useAuth } from "@/lib/auth/auth-context";

interface AuthGuardProps {
  children: ReactNode;
  /** Path yang dituju saat user belum login. Default: /login */
  redirectTo?: string;
}

/**
 * AuthGuard membungkus subtree route private. Saat status masih `loading`
 * (bootstrap sesi dari /me), tampilkan placeholder agar tidak flash ke
 * halaman login. Begitu `unauthenticated`, redirect ke `redirectTo`.
 */
export function AuthGuard({ children, redirectTo = "/login" }: AuthGuardProps) {
  const router = useRouter();
  const { status, user, error, retrySession } = useAuth();

  useEffect(() => {
    if (status === "unauthenticated") {
      router.replace(redirectTo);
    }
  }, [status, redirectTo, router]);

  if (status === "loading") {
    return (
      <main className="flex min-h-screen items-center justify-center px-4">
        <div className="text-center" role="status" aria-live="polite">
          <span className="mx-auto block h-8 w-8 animate-spin rounded-full border-2 border-brand-100 border-t-brand-600" />
          <p className="mt-3 text-sm font-medium text-slate-600">Memuat sesi...</p>
        </div>
      </main>
    );
  }

  if (status === "error") {
    return (
      <main className="flex min-h-screen items-center justify-center px-4">
        <section className="card w-full max-w-sm text-center" role="alert">
          <h1 className="text-lg font-semibold text-slate-900">Sesi belum dapat dimuat</h1>
          <p className="mt-2 text-sm leading-6 text-slate-600">
            {error ?? "Terjadi kendala saat mengambil profilmu."}
          </p>
          <button
            type="button"
            className="mt-5 inline-flex items-center justify-center rounded-md bg-brand-600 px-4 py-2 text-sm font-semibold text-white shadow-sm transition hover:bg-brand-700 focus:outline-none focus:ring-2 focus:ring-brand-500 focus:ring-offset-2"
            onClick={() => void retrySession()}
          >
            Coba lagi
          </button>
        </section>
      </main>
    );
  }

  if (status !== "authenticated") {
    return (
      <main className="flex min-h-screen items-center justify-center">
        <p className="text-sm text-slate-500">Mengalihkan ke halaman masuk...</p>
      </main>
    );
  }

  if (!user) {
    return (
      <main className="flex min-h-screen items-center justify-center px-4">
        <section className="card w-full max-w-sm text-center" role="status">
          <h1 className="text-lg font-semibold text-slate-900">Profil belum tersedia</h1>
          <p className="mt-2 text-sm leading-6 text-slate-600">
            Muat ulang profil untuk melanjutkan ke aplikasi.
          </p>
          <button
            type="button"
            className="mt-5 inline-flex items-center justify-center rounded-md bg-brand-600 px-4 py-2 text-sm font-semibold text-white shadow-sm transition hover:bg-brand-700 focus:outline-none focus:ring-2 focus:ring-brand-500 focus:ring-offset-2"
            onClick={() => void retrySession()}
          >
            Muat ulang profil
          </button>
        </section>
      </main>
    );
  }

  return <>{children}</>;
}
