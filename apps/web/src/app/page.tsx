"use client";

import { useRouter } from "next/navigation";

import { AppShell } from "@/components/shell/app-shell";
import { NavigationIcon } from "@/components/shell/icons";
import { useAuth } from "@/lib/auth/auth-context";
import { AuthGuard } from "@/lib/auth/auth-guard";
import { navigationItems } from "@/lib/navigation";

const upcomingFeatures = navigationItems.filter((item) => !item.available).slice(0, 3);

export default function HomePage() {
  return (
    <AuthGuard>
      <HomeContent />
    </AuthGuard>
  );
}

function HomeContent() {
  const router = useRouter();
  const { user, logout, isLoading } = useAuth();

  const handleLogout = async () => {
    await logout();
    router.replace("/login");
  };

  return (
    <AppShell user={user} isLoggingOut={isLoading} onLogout={handleLogout}>
      <section className="overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-sm">
        <div className="grid gap-6 p-6 sm:p-8 lg:grid-cols-[minmax(0,1fr)_19rem] lg:items-center">
          <div>
            <span className="inline-flex rounded-full bg-brand-50 px-3 py-1 text-xs font-semibold text-brand-700">
              Fondasi siap
            </span>
            <h2 className="mt-4 max-w-2xl text-2xl font-bold tracking-tight text-slate-950 sm:text-3xl">
              Selamat datang di pusat keuanganmu.
            </h2>
            <p className="mt-3 max-w-2xl text-sm leading-6 text-slate-600 sm:text-base">
              Shell aplikasi sudah siap untuk menampung fitur akun, transaksi, target, laporan,
              dan pengaturan pada epic berikutnya.
            </p>
          </div>

          <div className="rounded-2xl bg-slate-950 p-5 text-white shadow-lg shadow-slate-200">
            <p className="text-xs font-semibold uppercase tracking-[0.16em] text-brand-500">
              Sesi aktif
            </p>
            <p className="mt-3 truncate text-sm font-semibold" title={user?.email}>
              {user?.email ?? "Profil belum tersedia"}
            </p>
            <p className="mt-1 text-xs leading-5 text-slate-400">
              Identitas ini dimuat dari endpoint profil yang terlindungi.
            </p>
          </div>
        </div>
      </section>

      <section className="mt-6" aria-labelledby="upcoming-heading">
        <div className="flex items-end justify-between gap-4">
          <div>
            <p className="text-xs font-semibold uppercase tracking-[0.16em] text-brand-700">
              Berikutnya
            </p>
            <h2 id="upcoming-heading" className="mt-1 text-lg font-bold text-slate-900">
              Fitur yang segera hadir
            </h2>
          </div>
          <span className="text-xs font-medium text-slate-500">Epic 0002+</span>
        </div>

        <div className="mt-4 grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
          {upcomingFeatures.map((item) => (
            <article key={item.href} className="card flex min-h-44 flex-col">
              <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-brand-50 text-brand-700">
                <NavigationIcon name={item.icon} className="h-5 w-5" />
              </div>
              <h3 className="mt-4 font-semibold text-slate-900">{item.label}</h3>
              <p className="mt-1 text-sm leading-6 text-slate-600">{item.description}</p>
              <p className="mt-auto pt-4 text-xs font-semibold uppercase tracking-wide text-slate-400">
                Segera tersedia
              </p>
            </article>
          ))}
        </div>
      </section>

      <section className="card mt-6 text-center" aria-labelledby="empty-dashboard-heading">
        <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-full bg-slate-100 text-slate-500">
          <NavigationIcon name="reports" className="h-6 w-6" />
        </div>
        <h2 id="empty-dashboard-heading" className="mt-4 text-base font-semibold text-slate-900">
          Belum ada data ringkasan
        </h2>
        <p className="mx-auto mt-2 max-w-lg text-sm leading-6 text-slate-600">
          Saldo, arus kas, dan progres target akan muncul setelah fitur akun dan transaksi aktif.
        </p>
      </section>
    </AppShell>
  );
}
