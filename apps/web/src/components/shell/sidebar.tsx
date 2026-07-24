"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

import { ActionIcon, NavigationIcon } from "@/components/shell/icons";
import { isNavigationItemActive, navigationItems } from "@/lib/navigation";

interface SidebarProps {
  onClose?: () => void;
}

export function Sidebar({ onClose }: SidebarProps) {
  const pathname = usePathname();

  return (
    <div className="flex h-full flex-col bg-slate-950 text-slate-100">
      <div className="flex h-20 items-center border-b border-white/10 px-5">
        <Link href="/" className="flex min-w-0 items-center gap-3" onClick={onClose}>
          <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-brand-500 text-sm font-black tracking-tight text-white shadow-lg shadow-brand-900/30">
            PF
          </span>
          <span className="min-w-0">
            <span className="block truncate text-sm font-bold text-white">Personal Finance</span>
            <span className="block truncate text-xs text-slate-400">Tracker</span>
          </span>
        </Link>

        {onClose ? (
          <button
            type="button"
            className="ml-auto inline-flex h-10 w-10 items-center justify-center rounded-lg text-slate-300 transition hover:bg-white/10 hover:text-white focus:outline-none focus:ring-2 focus:ring-brand-500"
            onClick={onClose}
            aria-label="Tutup menu navigasi"
            autoFocus
          >
            <ActionIcon name="close" className="h-5 w-5" />
          </button>
        ) : null}
      </div>

      <nav className="flex-1 overflow-y-auto px-3 py-5" aria-label="Navigasi utama">
        <p className="px-3 text-[0.6875rem] font-semibold uppercase tracking-[0.16em] text-slate-500">
          Menu utama
        </p>
        <ul className="mt-3 space-y-1">
          {navigationItems.map((item) => {
            const active = item.available && isNavigationItemActive(item, pathname);
            const content = (
              <>
                <NavigationIcon name={item.icon} className="h-5 w-5 shrink-0" />
                <span className="min-w-0 flex-1 truncate">{item.label}</span>
                {!item.available ? (
                  <span className="rounded-full border border-white/10 bg-white/5 px-2 py-0.5 text-[0.625rem] font-semibold uppercase tracking-wide text-slate-400">
                    Segera
                  </span>
                ) : null}
              </>
            );

            return (
              <li key={item.href}>
                {item.available ? (
                  <Link
                    href={item.href}
                    className={`flex min-h-11 items-center gap-3 rounded-xl px-3 py-2.5 text-sm font-medium transition focus:outline-none focus:ring-2 focus:ring-brand-500 ${
                      active
                        ? "bg-brand-600 text-white shadow-sm shadow-brand-900/30"
                        : "text-slate-300 hover:bg-white/10 hover:text-white"
                    }`}
                    aria-current={active ? "page" : undefined}
                    onClick={onClose}
                  >
                    {content}
                  </Link>
                ) : (
                  <div
                    className="flex min-h-11 cursor-not-allowed items-center gap-3 rounded-xl px-3 py-2.5 text-sm font-medium text-slate-500"
                    aria-disabled="true"
                    title={`${item.label} segera tersedia`}
                  >
                    {content}
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      </nav>

      <div className="border-t border-white/10 p-4">
        <div className="rounded-xl bg-white/5 px-3 py-3">
          <p className="text-xs font-semibold text-slate-200">Fondasi aplikasi</p>
          <p className="mt-1 text-xs leading-5 text-slate-400">
            Menu fitur akan aktif bertahap pada epic berikutnya.
          </p>
        </div>
      </div>
    </div>
  );
}
