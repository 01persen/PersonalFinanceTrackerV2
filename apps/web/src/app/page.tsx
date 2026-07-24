"use client";

import { useRouter } from "next/navigation";
import { useEffect } from "react";

import { useAuth } from "@/lib/auth/auth-context";
import { AuthGuard } from "@/lib/auth/auth-guard";

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

  useEffect(() => {
    // Placeholder effect untuk hook lifecycle di test/storybook; tidak ada
    // efek samping tambahan di sini.
  }, []);

  const handleLogout = async () => {
    await logout();
    router.replace("/login");
  };

  return (
    <main className="mx-auto flex min-h-screen max-w-2xl flex-col gap-6 px-6 py-12">
      <header className="flex items-center justify-between">
        <div>
          <p className="text-xs uppercase tracking-wide text-brand-600">Personal Finance Tracker</p>
          <h1 className="mt-1 text-2xl font-bold text-slate-900">
            Halo{user?.email ? `, ${user.email}` : ""}
          </h1>
        </div>
        <button
          type="button"
          className="btn-secondary w-auto"
          onClick={handleLogout}
          disabled={isLoading}
        >
          Keluar
        </button>
      </header>

      <section className="card">
        <h2 className="text-lg font-semibold text-slate-900">Selamat datang</h2>
        <p className="mt-2 text-sm text-slate-600">
          Shell UI utama (sidebar + navigasi) akan dipasang di sub-0001-05. Untuk
          sekarang halaman ini hanya memastikan <code className="rounded bg-slate-100 px-1">/me</code>{" "}
          endpoint berhasil dipanggil dan auth guard mengarahkan user yang belum
          login ke <code className="rounded bg-slate-100 px-1">/login</code>.
        </p>
      </section>
    </main>
  );
}
