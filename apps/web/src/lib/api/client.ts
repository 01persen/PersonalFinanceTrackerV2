import {
  ACCESS_TOKEN_STORAGE_KEY,
  API_BASE_URL,
  API_V1_PREFIX,
  REFRESH_TOKEN_STORAGE_KEY,
} from "@/lib/env";

export class TokenStore {
  private readonly accessKey = ACCESS_TOKEN_STORAGE_KEY;
  private readonly refreshKey = REFRESH_TOKEN_STORAGE_KEY;

  getAccessToken(): string | null {
    if (typeof window === "undefined") return null;
    return window.localStorage.getItem(this.accessKey);
  }

  getRefreshToken(): string | null {
    if (typeof window === "undefined") return null;
    return window.localStorage.getItem(this.refreshKey);
  }

  setTokens(accessToken: string, refreshToken: string): void {
    if (typeof window === "undefined") return;
    window.localStorage.setItem(this.accessKey, accessToken);
    window.localStorage.setItem(this.refreshKey, refreshToken);
  }

  setAccessToken(accessToken: string): void {
    if (typeof window === "undefined") return;
    window.localStorage.setItem(this.accessKey, accessToken);
  }

  clear(): void {
    if (typeof window === "undefined") return;
    window.localStorage.removeItem(this.accessKey);
    window.localStorage.removeItem(this.refreshKey);
  }
}

export const tokenStore = new TokenStore();

export interface AuthUser {
  id: string;
  email: string;
  createdAt: string;
  updatedAt: string;
}

export interface TokenPair {
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
}

export interface ApiErrorBody {
  detail?: string | { msg: string }[];
}

export class ApiError extends Error {
  public readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = "ApiError";
    this.status = status;
  }
}

function buildUrl(path: string): string {
  return `${API_BASE_URL}${API_V1_PREFIX}${path}`;
}

async function parseError(response: Response): Promise<string> {
  try {
    const body = (await response.json()) as ApiErrorBody;
    if (typeof body.detail === "string") {
      return body.detail;
    }
    if (Array.isArray(body.detail) && body.detail.length > 0) {
      return body.detail.map((entry) => entry.msg).join("; ");
    }
  } catch {
    // Body bukan JSON; fallthrough.
  }
  return response.statusText || `HTTP ${response.status}`;
}

export interface RequestOptions {
  method?: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  body?: unknown;
  accessToken?: string | null;
  signal?: AbortSignal;
}

export async function apiRequest<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const headers: Record<string, string> = {
    Accept: "application/json",
  };

  if (options.body !== undefined) {
    headers["Content-Type"] = "application/json";
  }

  const accessToken = options.accessToken ?? tokenStore.getAccessToken();
  if (accessToken) {
    headers.Authorization = `Bearer ${accessToken}`;
  }

  const response = await fetch(buildUrl(path), {
    method: options.method ?? "GET",
    headers,
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
    signal: options.signal,
  });

  if (!response.ok) {
    const message = await parseError(response);
    throw new ApiError(response.status, message);
  }

  if (response.status === 204) {
    return undefined as T;
  }

  return (await response.json()) as T;
}

export async function registerRequest(payload: { email: string; password: string }): Promise<TokenPair> {
  const data = await apiRequest<{
    access_token: string;
    refresh_token: string;
    expires_in: number;
  }>("/auth/register", {
    method: "POST",
    body: payload,
  });

  return {
    accessToken: data.access_token,
    refreshToken: data.refresh_token,
    expiresIn: data.expires_in,
  };
}

export async function loginRequest(payload: { email: string; password: string }): Promise<TokenPair> {
  const data = await apiRequest<{
    access_token: string;
    refresh_token: string;
    expires_in: number;
  }>("/auth/login", {
    method: "POST",
    body: payload,
  });

  return {
    accessToken: data.access_token,
    refreshToken: data.refresh_token,
    expiresIn: data.expires_in,
  };
}

export async function logoutRequest(): Promise<void> {
  await apiRequest<void>("/auth/logout", { method: "POST" });
}

export async function fetchMe(accessToken: string | null): Promise<AuthUser> {
  const data = await apiRequest<{
    id: string;
    email: string;
    created_at: string;
    updated_at: string;
  }>("/auth/me", { accessToken });

  return {
    id: data.id,
    email: data.email,
    createdAt: data.created_at,
    updatedAt: data.updated_at,
  };
}
