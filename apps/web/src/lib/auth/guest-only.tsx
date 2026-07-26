"use client";

import { useRouter } from "next/navigation";
import { useEffect, type ReactNode } from "react";

import { useAuth } from "@/lib/auth/auth-context";

interface GuestOnlyProps {
  children: ReactNode;
  /** Path yang dituju saat user ternyata sudah login. Default: / */
  redirectTo?: string;
}

/**
 * GuestOnly adalah kebalikan AuthGuard — dipasang di /login & /register agar
 * user yang sudah punya sesi langsung diarahkan ke halaman utama, bukan
 * melihat form login lagi.
 */
export function GuestOnly({ children, redirectTo = "/" }: GuestOnlyProps) {
  const router = useRouter();
  const { status } = useAuth();

  useEffect(() => {
    if (status === "authenticated") {
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

  return <>{children}</>;
}
