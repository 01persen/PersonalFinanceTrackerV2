"use client";

import type { ReactNode } from "react";

interface DashboardGridProps {
  children: ReactNode;
}

/**
 * Responsive 12-column grid container for the dashboard page
 * (sub-0007-02). Renders a CSS grid that mirrors the desktop-first
 * layout pinned in the issue spec:
 *
 *   - KPI cards  → row 1, full width (handled by `<KpiCards>`)
 *   - Charts     → row 2, 8/12 networth + 4/12 income-vs-expense
 *   - Widgets    → row 3, 6/6 goals + debts
 *
 * Each child decides its own `col-span` via Tailwind classes — the
 * container just owns the grid template + vertical spacing. Keeps the
 * layout flexible so sub-tasks 03/04/05/06 can drop their sections
 * in without rewriting the container.
 *
 * Mobile (below `md` / 768 px) collapses every row to a single column;
 * sub-0007-07 owns the dedicated `/dashboard/full` mobile route.
 */
export function DashboardGrid({ children }: DashboardGridProps) {
  return (
    <div
      className="grid grid-cols-1 gap-4 md:grid-cols-12 md:gap-6"
      data-testid="dashboard-grid"
    >
      {children}
    </div>
  );
}
