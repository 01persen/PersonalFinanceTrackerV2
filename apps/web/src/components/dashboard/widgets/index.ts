/**
 * Public surface for the dashboard widget sub-components (sub-0007-06).
 * The directory groups the goal-progress + debt-summary widgets under
 * `components/dashboard/widgets` so the higher-level
 * `components/dashboard/index.ts` re-export stays shallow and the
 * widget implementations stay scoped to one folder.
 *
 * Each widget owns its own `data-*` + `aria-*` wiring (the page
 * just provides the typed payload from `lib/dashboard/types.ts`),
 * which keeps the page-level wiring free of widget-internal concerns.
 */
export { GoalProgressSection } from "@/components/dashboard/widgets/goal-progress-section";
export {
  DebtSummarySection,
} from "@/components/dashboard/widgets/debt-summary-section";
