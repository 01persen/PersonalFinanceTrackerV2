/**
 * Public surface for the dashboard chart sub-components (sub-0007-03+).
 * The directory groups every chart under `components/dashboard/charts`
 * so the higher-level `components/dashboard/index.ts` re-export stays
 * shallow and the chart implementations stay scoped to one folder.
 *
 * Each chart file owns its own `data-*` and `aria-*` wiring so the
 * page can drop the chart in without any extra props plumbing —
 * the chart reads from the typed `DashboardNetworthTrendPoint[]`
 * shape exposed by `lib/dashboard/types.ts` (sub-0007-02).
 */
export { NetworthTrendChart } from "@/components/dashboard/charts/networth-trend-chart";
