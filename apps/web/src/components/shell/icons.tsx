import type { ReactNode, SVGProps } from "react";

import type { NavigationIconName } from "@/lib/navigation";

const navigationPaths: Record<NavigationIconName, ReactNode> = {
  dashboard: (
    <>
      <rect x="3" y="3" width="7" height="7" rx="1.5" />
      <rect x="14" y="3" width="7" height="7" rx="1.5" />
      <rect x="3" y="14" width="7" height="7" rx="1.5" />
      <rect x="14" y="14" width="7" height="7" rx="1.5" />
    </>
  ),
  accounts: (
    <>
      <path d="M4 7.5h15a2 2 0 0 1 2 2v8.5a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h12" />
      <path d="M16 12h5v4h-5a2 2 0 0 1 0-4Z" />
    </>
  ),
  transactions: (
    <>
      <path d="M5 7h14" />
      <path d="m15 3 4 4-4 4" />
      <path d="M19 17H5" />
      <path d="m9 13-4 4 4 4" />
    </>
  ),
  categories: (
    <>
      <path d="m20.5 13.5-7 7a2 2 0 0 1-2.8 0L3.5 13.3A2 2 0 0 1 3 12V5a2 2 0 0 1 2-2h7a2 2 0 0 1 1.4.6l7.1 7.1a2 2 0 0 1 0 2.8Z" />
      <circle cx="8" cy="8" r="1.25" />
    </>
  ),
  goals: (
    <>
      <circle cx="12" cy="12" r="8.5" />
      <circle cx="12" cy="12" r="4.5" />
      <path d="M12 3v3M21 12h-3M12 21v-3M3 12h3" />
    </>
  ),
  debts: (
    <>
      <path d="M6 3h10l3 3v15l-3-1.5L13 21l-3-1.5L7 21l-2-1V4a1 1 0 0 1 1-1Z" />
      <path d="M9 8h6M9 12h6M9 16h4" />
    </>
  ),
  reports: (
    <>
      <path d="M4 20V10M10 20V4M16 20v-7M22 20H2" />
      <path d="m4 7 6-4 6 6 5-4" />
    </>
  ),
  settings: (
    <>
      <path d="M4 6h10M18 6h2M4 12h2M10 12h10M4 18h7M15 18h5" />
      <circle cx="16" cy="6" r="2" />
      <circle cx="8" cy="12" r="2" />
      <circle cx="13" cy="18" r="2" />
    </>
  ),
  recurring: (
    <>
      <circle cx="12" cy="12" r="8.5" />
      <path d="M12 7v5l3 2M7 3.8 4.5 4 4.8 6.5" />
    </>
  ),
};

export function NavigationIcon({
  name,
  ...props
}: SVGProps<SVGSVGElement> & { name: NavigationIconName }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.75"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
      {...props}
    >
      {navigationPaths[name]}
    </svg>
  );
}

const actionPaths = {
  menu: (
    <>
      <path d="M4 7h16M4 12h16M4 17h16" />
    </>
  ),
  close: (
    <>
      <path d="m6 6 12 12M18 6 6 18" />
    </>
  ),
  logout: (
    <>
      <path d="M10 5H5a2 2 0 0 0-2 2v10a2 2 0 0 0 2 2h5M14 8l4 4-4 4M18 12H8" />
    </>
  ),
  /**
   * Pagination chevrons used by the cicilan history pagination
   * (sub-0006-06). Added here so the action-icon surface stays
   * flat — pages import `ActionIcon` only, no separate chevron
   * component, no extra dependency on an icon library.
   */
  "chevron-left": (
    <>
      <path d="M14 6 8 12l6 6" />
    </>
  ),
  "chevron-right": (
    <>
      <path d="m10 6 6 6-6 6" />
    </>
  ),
} satisfies Record<string, ReactNode>;

export function ActionIcon({
  name,
  ...props
}: SVGProps<SVGSVGElement> & { name: keyof typeof actionPaths }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.75"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
      {...props}
    >
      {actionPaths[name]}
    </svg>
  );
}
