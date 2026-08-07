"use client";

import { DashboardContent } from "@/components/dashboard/dashboard-content";
import { AuthGuard } from "@/lib/auth/auth-guard";

/**
 * Root dashboard route (`/`).
 *
 * Wraps the shared `<DashboardContent>` shell (sub-0007-02 + sub-0007-07)
 * in `<AuthGuard>` so an unauthenticated visitor lands on `/login`
 * before the page tries to read the six dashboard endpoints. The
 * shell itself owns the parallel fetch + race defense + responsive
 * layout that splits between the mobile ringkas summary (sub-0007-07,
 * visible below the `md` breakpoint) and the full desktop dashboard
 * (sub-0007-02/03/04/05/06, visible on `md` and up).
 */
export default function DashboardPage() {
  return (
    <AuthGuard>
      <DashboardContent showMobileSummary />
    </AuthGuard>
  );
}