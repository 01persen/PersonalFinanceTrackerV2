"use client";

import { usePathname } from "next/navigation";

import { ActionIcon } from "@/components/shell/icons";
import type { AuthUser } from "@/lib/api/client";
import { getCurrentNavigationItem } from "@/lib/navigation";

interface AppHeaderProps {
  user: AuthUser | null;
  isLoggingOut: boolean;
  mobileNavigationOpen: boolean;
  onOpenNavigation: () => void;
  onLogout: () => Promise<void>;
}

function getDisplayName(email: string): string {
  const localPart = email.split("@")[0] ?? "";
  const words = localPart.split(/[._+-]+/).filter(Boolean);
  if (words.length === 0) return "Pengguna";
  return words.map((word) => `${word.charAt(0).toUpperCase()}${word.slice(1)}`).join(" ");
}

export function AppHeader({
  user,
  isLoggingOut,
  mobileNavigationOpen,
  onOpenNavigation,
  onLogout,
}: AppHeaderProps) {
  const pathname = usePathname();
  const currentItem = getCurrentNavigationItem(pathname);
  const userEmail = user?.email ?? "";
  const displayName = userEmail ? getDisplayName(userEmail) : "Profil belum tersedia";
  const initial = displayName.charAt(0).toUpperCase() || "P";

  return (
    <header className="sticky top-0 z-30 border-b border-slate-200 bg-white/95 backdrop-blur supports-[backdrop-filter]:bg-white/80">
      <div className="flex h-16 items-center gap-3 px-4 sm:px-6 lg:px-8">
        <button
          type="button"
          className="inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-lg border border-slate-200 bg-white text-slate-700 shadow-sm transition hover:bg-slate-50 focus:outline-none focus:ring-2 focus:ring-brand-500 lg:hidden"
          onClick={onOpenNavigation}
          aria-label="Buka menu navigasi"
          aria-controls="mobile-sidebar"
          aria-expanded={mobileNavigationOpen}
        >
          <ActionIcon name="menu" className="h-5 w-5" />
        </button>

        <div className="min-w-0">
          <p className="hidden text-xs font-medium text-slate-500 sm:block">Personal Finance Tracker</p>
          <h1 className="truncate text-base font-bold text-slate-900 sm:text-lg">{currentItem.label}</h1>
        </div>

        <div className="ml-auto flex min-w-0 items-center gap-2 sm:gap-3">
          <div className="hidden h-9 w-9 shrink-0 items-center justify-center rounded-full bg-brand-100 text-sm font-bold text-brand-700 sm:flex">
            {initial}
          </div>
          <div className="min-w-0 max-w-24 sm:max-w-44 lg:max-w-56">
            <p className="truncate text-xs font-semibold text-slate-800 sm:text-sm" title={displayName}>
              {displayName}
            </p>
            <p className="hidden truncate text-xs text-slate-500 md:block" title={userEmail}>
              {userEmail || "Data profil dari /me kosong"}
            </p>
          </div>
          <button
            type="button"
            className="inline-flex h-10 shrink-0 items-center justify-center gap-2 rounded-lg border border-slate-200 bg-white px-2.5 text-sm font-semibold text-slate-700 shadow-sm transition hover:bg-slate-50 focus:outline-none focus:ring-2 focus:ring-brand-500 disabled:cursor-not-allowed disabled:opacity-60 sm:px-3"
            onClick={() => void onLogout()}
            disabled={isLoggingOut}
            aria-label={isLoggingOut ? "Sedang keluar" : "Keluar dari aplikasi"}
          >
            <ActionIcon name="logout" className="h-4 w-4" />
            <span className="hidden sm:inline">{isLoggingOut ? "Keluar..." : "Keluar"}</span>
          </button>
        </div>
      </div>
    </header>
  );
}
