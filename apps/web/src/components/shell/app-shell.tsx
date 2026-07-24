"use client";

import { useEffect, useState, type ReactNode } from "react";

import { AppHeader } from "@/components/shell/app-header";
import { Sidebar } from "@/components/shell/sidebar";
import type { AuthUser } from "@/lib/api/client";

interface AppShellProps {
  user: AuthUser | null;
  isLoggingOut: boolean;
  onLogout: () => Promise<void>;
  children: ReactNode;
}

export function AppShell({ user, isLoggingOut, onLogout, children }: AppShellProps) {
  const [mobileNavigationOpen, setMobileNavigationOpen] = useState(false);

  useEffect(() => {
    if (!mobileNavigationOpen) return;

    const previousOverflow = document.body.style.overflow;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setMobileNavigationOpen(false);
    };

    document.body.style.overflow = "hidden";
    window.addEventListener("keydown", handleKeyDown);

    return () => {
      document.body.style.overflow = previousOverflow;
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, [mobileNavigationOpen]);

  return (
    <div className="min-h-screen bg-slate-50">
      <aside className="fixed inset-y-0 left-0 z-40 hidden w-72 lg:block">
        <Sidebar />
      </aside>

      {mobileNavigationOpen ? (
        <div className="fixed inset-0 z-50 lg:hidden">
          <button
            type="button"
            className="absolute inset-0 bg-slate-950/60 backdrop-blur-sm"
            onClick={() => setMobileNavigationOpen(false)}
            aria-label="Tutup menu navigasi"
          />
          <aside
            id="mobile-sidebar"
            className="absolute inset-y-0 left-0 w-[min(20rem,88vw)] shadow-2xl"
            role="dialog"
            aria-modal="true"
            aria-label="Menu navigasi"
          >
            <Sidebar onClose={() => setMobileNavigationOpen(false)} />
          </aside>
        </div>
      ) : null}

      <div className="min-h-screen lg:pl-72">
        <AppHeader
          user={user}
          isLoggingOut={isLoggingOut}
          mobileNavigationOpen={mobileNavigationOpen}
          onOpenNavigation={() => setMobileNavigationOpen(true)}
          onLogout={onLogout}
        />
        <main id="main-content" className="mx-auto w-full max-w-7xl p-4 sm:p-6 lg:p-8">
          {children}
        </main>
      </div>
    </div>
  );
}
