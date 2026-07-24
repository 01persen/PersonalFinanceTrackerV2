"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";

import { useAuth } from "@/lib/auth/auth-context";
import { GuestOnly } from "@/lib/auth/guest-only";

export default function LoginPage() {
  return (
    <GuestOnly>
      <LoginForm />
    </GuestOnly>
  );
}

function LoginForm() {
  const router = useRouter();
  const { login, isLoading, error, clearError } = useAuth();
  const [email, setEmail] = useState<string>("");
  const [password, setPassword] = useState<string>("");
  const [validationError, setValidationError] = useState<string | null>(null);

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setValidationError(null);
    clearError();

    const trimmedEmail = email.trim();
    if (!trimmedEmail || !password) {
      setValidationError("Email dan kata sandi wajib diisi.");
      return;
    }

    try {
      await login({ email: trimmedEmail, password });
      router.replace("/");
    } catch {
      // Error message sudah di-handle via AuthContext state.
    }
  };

  const displayError = validationError ?? error;

  return (
    <main className="flex min-h-screen items-center justify-center px-4 py-12">
      <div className="w-full max-w-sm">
        <div className="mb-6 text-center">
          <p className="text-xs uppercase tracking-wide text-brand-600">Personal Finance Tracker</p>
          <h1 className="mt-1 text-2xl font-bold text-slate-900">Masuk</h1>
          <p className="mt-1 text-sm text-slate-500">Lanjut kelola keuanganmu.</p>
        </div>

        <form className="card flex flex-col gap-4" onSubmit={handleSubmit} noValidate>
          <div>
            <label htmlFor="email" className="form-label">
              Email
            </label>
            <input
              id="email"
              type="email"
              autoComplete="email"
              required
              className="form-input mt-1"
              value={email}
              onChange={(event) => setEmail(event.target.value)}
              disabled={isLoading}
            />
          </div>

          <div>
            <label htmlFor="password" className="form-label">
              Kata sandi
            </label>
            <input
              id="password"
              type="password"
              autoComplete="current-password"
              required
              minLength={8}
              className="form-input mt-1"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              disabled={isLoading}
            />
          </div>

          {displayError ? (
            <p role="alert" className="form-error">
              {displayError}
            </p>
          ) : null}

          <button type="submit" className="btn-primary" disabled={isLoading}>
            {isLoading ? "Memproses..." : "Masuk"}
          </button>
        </form>

        <p className="mt-4 text-center text-sm text-slate-600">
          Belum punya akun?{" "}
          <Link href="/register" className="font-medium text-brand-600 hover:underline">
            Daftar di sini
          </Link>
        </p>
      </div>
    </main>
  );
}
