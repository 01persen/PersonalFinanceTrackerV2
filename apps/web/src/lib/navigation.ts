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
    available: false,
  },
  {
    label: "Transaksi",
    href: "/transactions",
    description: "Catat pemasukan, pengeluaran, dan transfer.",
    icon: "transactions",
    available: false,
  },
  {
    label: "Kategori",
    href: "/categories",
    description: "Atur kategori dan temukan transaksi lebih cepat.",
    icon: "categories",
    available: false,
  },
  {
    label: "Target keuangan",
    href: "/goals",
    description: "Pantau tabungan dan dana darurat.",
    icon: "goals",
    available: false,
  },
  {
    label: "Utang",
    href: "/debts",
    description: "Pantau saldo dan pembayaran utang.",
    icon: "debts",
    available: false,
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
    available: false,
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
