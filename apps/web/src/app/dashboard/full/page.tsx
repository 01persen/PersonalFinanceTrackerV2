"use client";

import Link from "next/link";

import { DashboardContent } from "@/components/dashboard/dashboard-content";
import { AuthGuard } from "@/lib/auth/auth-guard";

/**
 * `/dashboard/full` — full-screen dashboard route (sub-0007-07).
 *
 * Renders the same `<DashboardContent>` shell as the root dashboard
 * (`/`) but with `showMobileSummary={false}` so a mobile visitor who
 * tapped "Lihat dashboard lengkap" gets the desktop layout regardless
 * of viewport width. A "Kembali ke Beranda" back-link sits at the top
 * of the content area so the user has an obvious navigation affordance
 * back to the mobile summary view (and from any desktop visitor who
 * landed here directly).
 *
 * Why a dedicated route instead of a `?view=full` query string:
 *
 *   - The TL decision (pinned in the issue body) prefers a clean
 *     shareable URL. A query string would survive a share but the
 *     canonical landing route stays at `/`.
 *   - The full layout has its own loading/error/empty states so it
 *     works on its own — no parameter plumbing required.
 *
 * The route reuses the existing fetch + race-defense machinery by
 * delegating to the shared shell. The shell's `topSlot` prop carries
 * the back-link so the rest of the dashboard chrome (AppShell +
 * DashboardHeader) stays untouched.
 */
export default function DashboardFullPage() {
  return (
    <AuthGuard>
      <DashboardContent
        showMobileSummary={false}
        topSlot={
          <Link
            href="/"
            className="mb-3 inline-flex min-h-[44px] items-center gap-1 rounded-md px-2 text-sm font-semibold text-brand-700 transition hover:text-brand-800 focus:outline-none focus:ring-2 focus:ring-brand-500"
            aria-label="Kembali ke beranda"
            data-testid="dashboard-full-back"
          >
            <span aria-hidden="true">←</span>
            <span>Kembali ke Beranda</span>
          </Link>
        }
      />
    </AuthGuard>
  );
}