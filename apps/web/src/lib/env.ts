/**
 * API base URL. Default menunjuk ke server lokal hasil kerja sub-0001-01..03
 * (FastAPI di http://localhost:8000). Override via env di Vercel / production.
 */
export const API_BASE_URL: string =
  process.env.NEXT_PUBLIC_API_BASE_URL?.replace(/\/+$/, "") || "http://localhost:8000";

export const API_V1_PREFIX = "/api/v1";

/** Storage key untuk access token. */
export const ACCESS_TOKEN_STORAGE_KEY = "pft.access_token";
/** Storage key untuk refresh token. */
export const REFRESH_TOKEN_STORAGE_KEY = "pft.refresh_token";
