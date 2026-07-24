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
  const { status } = useAuth();

  useEffect(() => {
    if (status === "unauthenticated") {
      router.replace(redirectTo);
    }
  }, [status, redirectTo, router]);

  if (status === "loading") {
    return (
      <main className="flex min-h-screen items-center justify-center">
        <p className="text-sm text-slate-500">Memuat sesi...</p>
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

  return <>{children}</>;
}
