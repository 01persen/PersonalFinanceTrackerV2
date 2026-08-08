"use client";

import type { AuthUser } from "@/lib/api/client";

interface DashboardHeaderProps {
  user: AuthUser | null;
}

/**
 * Extract a friendly display name from the user's email local part.
 * Mirrors the same logic used in `<AppHeader>` (`app-header.tsx`) so the
 * greeting stays consistent across the header + hero. Falls back to
 * "Pengguna" when the email is empty or malformed.
 */
function resolveDisplayName(email: string | null | undefined): string {
  if (!email) return "Pengguna";
  const localPart = email.split("@")[0] ?? "";
  const words = localPart.split(/[._+-]+/).filter(Boolean);
  if (words.length === 0) return "Pengguna";
  return words
    .map((word) => `${word.charAt(0).toUpperCase()}${word.slice(1)}`)
    .join(" ");
}

/**
 * Top-of-page greeting + dashboard subtitle (sub-0007-02). Renders
 * below the `<AppHeader>` / `<AppShell>` chrome so it stays focused on
 * the personal finance dashboard content. The user-facing greeting
 * uses the same display-name derivation as the global header so the
 * two surfaces read as one continuous identity.
 */
export function DashboardHeader({ user }: DashboardHeaderProps) {
  const displayName = resolveDisplayName(user?.email);

  return (
    <header className="flex flex-wrap items-end justify-between gap-3">
      <div className="min-w-0">
        <p className="text-xs font-semibold uppercase tracking-[0.16em] text-brand-700">
          Epic 0007 · Dashboard
        </p>
        <h2 className="mt-1 text-2xl font-bold tracking-tight text-slate-950 sm:text-3xl">
          Halo, {displayName}.
        </h2>
        <p className="mt-1 max-w-2xl text-sm leading-6 text-slate-600">
          Gambaran singkat keuanganmu: networth, arus kas bulan ini,
          dan progres dana darurat. Detail lengkap ada di ringkasan
          akun, transaksi, dan target.
        </p>
      </div>
    </header>
  );
}
