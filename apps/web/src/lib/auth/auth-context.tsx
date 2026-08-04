"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";

import {
  ApiError,
  fetchMe,
  loginRequest,
  logoutRequest,
  registerRequest,
  tokenStore,
  type AuthUser,
} from "@/lib/api/client";

export type AuthStatus = "loading" | "authenticated" | "unauthenticated" | "error";

interface AuthContextValue {
  status: AuthStatus;
  user: AuthUser | null;
  isLoading: boolean;
  error: string | null;
  login: (payload: { email: string; password: string }) => Promise<void>;
  register: (payload: { email: string; password: string }) => Promise<void>;
  logout: () => Promise<void>;
  retrySession: () => Promise<void>;
  clearError: () => void;
}

const AuthContext = createContext<AuthContextValue | undefined>(undefined);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [status, setStatus] = useState<AuthStatus>("loading");
  const [user, setUser] = useState<AuthUser | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState<boolean>(false);
  const bootstrappedRef = useRef<boolean>(false);

  const bootstrap = useCallback(async () => {
    const accessToken = tokenStore.getAccessToken();
    setError(null);

    if (!accessToken) {
      setUser(null);
      setStatus("unauthenticated");
      return;
    }

    setStatus("loading");

    try {
      const profile = await fetchMe(accessToken);
      setUser(profile);
      setStatus("authenticated");
    } catch (err) {
      setUser(null);

      if (err instanceof ApiError && (err.status === 401 || err.status === 403)) {
        tokenStore.clear();
        setStatus("unauthenticated");
        return;
      }

      setError("Sesi tidak dapat dimuat. Periksa koneksi lalu coba lagi.");
      setStatus("error");
    }
  }, []);

  useEffect(() => {
    if (bootstrappedRef.current) return;
    bootstrappedRef.current = true;
    void bootstrap();
  }, [bootstrap]);

  const login = useCallback<AuthContextValue["login"]>(async (payload) => {
    setIsLoading(true);
    setError(null);
    try {
      const pair = await loginRequest(payload);
      tokenStore.setTokens(pair.accessToken, pair.refreshToken);
      const profile = await fetchMe(pair.accessToken);
      setUser(profile);
      setStatus("authenticated");
    } catch (err) {
      const message = err instanceof ApiError ? err.message : "Tidak bisa masuk, coba lagi.";
      setError(message);
      setUser(null);
      setStatus("unauthenticated");
      throw err;
    } finally {
      setIsLoading(false);
    }
  }, []);

  const register = useCallback<AuthContextValue["register"]>(async (payload) => {
    setIsLoading(true);
    setError(null);
    try {
      const pair = await registerRequest(payload);
      tokenStore.setTokens(pair.accessToken, pair.refreshToken);
      const profile = await fetchMe(pair.accessToken);
      setUser(profile);
      setStatus("authenticated");
    } catch (err) {
      const message =
        err instanceof ApiError ? err.message : "Pendaftaran gagal, coba lagi.";
      setError(message);
      setUser(null);
      setStatus("unauthenticated");
      throw err;
    } finally {
      setIsLoading(false);
    }
  }, []);

  const logout = useCallback<AuthContextValue["logout"]>(async () => {
    setIsLoading(true);
    setError(null);
    try {
      await logoutRequest();
    } catch (err) {
      // Endpoint logout bisa gagal (token expired / network), tapi untuk MVP
      // kita tetap bersihkan state lokal karena logout pada dasarnya stateless.
      if (err instanceof ApiError) {

        console.warn("[auth] logout server-side gagal:", err.status, err.message);
      }
    } finally {
      tokenStore.clear();
      setUser(null);
      setStatus("unauthenticated");
      setIsLoading(false);
    }
  }, []);

  const clearError = useCallback(() => setError(null), []);

  const value = useMemo<AuthContextValue>(
    () => ({
      status,
      user,
      isLoading,
      error,
      login,
      register,
      logout,
      retrySession: bootstrap,
      clearError,
    }),
    [status, user, isLoading, error, login, register, logout, bootstrap, clearError],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) {
    throw new Error("useAuth harus dipanggil di dalam <AuthProvider>");
  }
  return ctx;
}
