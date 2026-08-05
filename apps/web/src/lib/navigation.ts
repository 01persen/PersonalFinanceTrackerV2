export type NavigationIconName =
  | "dashboard"
  | "accounts"
  | "transactions"
  | "categories"
  | "goals"
  | "debts"
  | "reports"
  | "settings"
  | "recurring";

export interface NavigationItem {
  label: string;
  href: string;
  description: string;
  icon: NavigationIconName;
  available: boolean;
}

export const navigationItems: readonly NavigationItem[] = [
  {
    label: "Ringkasan",
    href: "/",
    description: "Lihat gambaran keuangan dalam satu tempat.",
    icon: "dashboard",
    available: true,
  },
  {
    label: "Akun",
    href: "/accounts",
    description: "Kelola kas, bank, dompet digital, dan akun lainnya.",
    icon: "accounts",
    available: true,
  },
  {
    label: "Transaksi",
    href: "/transactions",
    description: "Catat pemasukan, pengeluaran, dan transfer.",
    icon: "transactions",
    available: true,
  },
  {
    label: "Kategori",
    href: "/categories",
    description: "Atur kategori dan temukan transaksi lebih cepat.",
    icon: "categories",
    available: true,
  },
  {
    label: "Target keuangan",
    href: "/goals",
    description: "Pantau tabungan dan dana darurat.",
    icon: "goals",
    // sub-0005-03 ships the read-only list (filter chip + progress bar
    // + empty/error states); create / edit / detail land in
    // sub-0005-04 + sub-0005-05 but the sidebar entry stays available
    // from this commit forward so users can navigate to /goals.
    available: true,
  },
  {
    label: "Utang",
    href: "/debts",
    description: "Pantau saldo dan pembayaran utang.",
    icon: "debts",
    // sub-0006-04 ships the read-only list (status + kind filter
    // chips + summary tiles + loading/error/empty states). The
    // create / edit form + per-row history land in sub-0006-05 and
    // sub-0006-06 (Stage 4), but the sidebar entry is flipped
    // available from this commit forward so users can navigate to
    // /debts. Same rollout cadence as sub-0005-03 for /goals.
    available: true,
  },
  {
    label: "Laporan",
    href: "/reports",
    description: "Analisis arus kas dan perkembangan networth.",
    icon: "reports",
    available: false,
  },
  {
    label: "Pengaturan",
    href: "/settings",
    description: "Kelola preferensi, ekspor, dan backup data.",
    icon: "settings",
    // sub-0008-04 ships the settings page (profile + preferensi form,
    // optimistic + rollback pattern, ETag-driven re-fetch). Export +
    // backup actions land in sub-0008-05 (Stage 4 parallel) but the
    // sidebar entry is flipped available from this commit forward so
    // users can navigate to /settings.
    available: true,
  },
  {
    label: "Tagihan berulang",
    href: "/recurring",
    description: "Atur tagihan tetap dan pengingat jatuh tempo.",
    icon: "recurring",
    available: false,
  },
];

export function isNavigationItemActive(item: NavigationItem, pathname: string): boolean {
  if (item.href === "/") return pathname === "/";
  return pathname === item.href || pathname.startsWith(`${item.href}/`);
}

export function getCurrentNavigationItem(pathname: string): NavigationItem {
  return navigationItems.find((item) => isNavigationItemActive(item, pathname)) ?? navigationItems[0];
}
