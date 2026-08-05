import {
  ApiError,
  apiRequestWithHeaders,
  type ApiErrorBody,
} from "@/lib/api/client";

/**
 * Settings client (epic-0008, sub-0008-04).
 *
 * Bundles profile (email, display_name) + preferences (currency,
 * locale, week_start, ef_multiplier, dependents_count, theme) +
 * optimistic-concurrency `version` for the FE settings page. Wire
 * shape mirrors `SettingsPublic` in
 * `apps/api/src/app/api/schemas.py`.
 *
 * Optimistic concurrency:
 *
 * * GET returns `version: int` in the body *and* the `ETag: "<v>"`
 *   response header. The FE stores both so the round-trip on PATCH
 *   can send `If-Match: "<v>"` and the stale-token path surfaces a
 *   clean 412 instead of a generic 409.
 * * PATCH echoes the version via `If-Match`. A stale echo returns
 *   `412 Precondition Failed`; the FE refetches and prompts the
 *   user to retry rather than silently clobbering either side of a
 *   2-tab race (AC (e)).
 *
 * Validation that the BE handles for us — kept as documentation so
 * future FE contributors don't add redundant client-side checks:
 *
 * * `currency` locked to `"IDR"`, `locale` to `"id-ID"` (Pydantic
 *   literal → 422). FE UI disables these fields.
 * * `week_start` enum (senin|selasa|rabu|kamis|jumat|sabtu|minggu)
 *   (Pydantic literal → 422).
 * * `ef_multiplier >= 1` (Pydantic `Field(ge=1)` → 422).
 * * `display_name` length 0..100 (Pydantic → 422).
 * * Unknown fields → 422 via `extra="forbid"`.
 *
 * Error mapping mirrors the rest of the app (see `formatGoalApiError`
 * / `formatAccountApiError`): 401/403 → sesi berakhir, 404 → tidak
 * ditemukan, 412 → data telah berubah (handled separately so the FE
 * can refresh + retry without showing the generic "server" banner),
 * 422 → per-field validation, 5xx → server gangguan.
 */

export type WeekStart =
  | "senin"
  | "selasa"
  | "rabu"
  | "kamis"
  | "jumat"
  | "sabtu"
  | "minggu";

export const WEEK_START_VALUES: readonly WeekStart[] = [
  "senin",
  "selasa",
  "rabu",
  "kamis",
  "jumat",
  "sabtu",
  "minggu",
] as const;

export const WEEK_START_LABEL: Record<WeekStart, string> = {
  senin: "Senin",
  selasa: "Selasa",
  rabu: "Rabu",
  kamis: "Kamis",
  jumat: "Jumat",
  sabtu: "Sabtu",
  minggu: "Minggu",
};

export const LOCKED_CURRENCY = "IDR" as const;
export const LOCKED_LOCALE = "id-ID" as const;

export const DISPLAY_NAME_MAX = 100;

/** Lower bound enforced by the BE (`Field(ge=1)` on ef_multiplier). */
export const EF_MULTIPLIER_MIN = 1;
/** Sensible upper bound for the input — not enforced by BE, but
 *  caps accidental fat-finger input without hiding any real use case.
 */
export const EF_MULTIPLIER_MAX = 60;

export interface Settings {
  email: string;
  displayName: string | null;
  currency: string;
  locale: string;
  weekStart: WeekStart;
  efMultiplier: number;
  dependentsCount: number;
  theme: string;
  version: number;
  updatedAt: string;
}

export interface SettingsResponse {
  settings: Settings;
  etag: string | null;
}

interface RawSettingsPayload {
  email?: unknown;
  display_name?: unknown;
  currency?: unknown;
  locale?: unknown;
  week_start?: unknown;
  ef_multiplier?: unknown;
  dependents_count?: unknown;
  theme?: unknown;
  version?: unknown;
  updated_at?: unknown;
}

function toFiniteInt(value: unknown): number {
  if (typeof value === "number" && Number.isFinite(value)) return Math.trunc(value);
  if (typeof value === "string" && value.length > 0) {
    const parsed = Number.parseInt(value, 10);
    if (Number.isFinite(parsed)) return parsed;
  }
  return 0;
}

function toStringOrNull(value: unknown): string | null {
  if (typeof value === "string") return value;
  return null;
}

function isWeekStart(value: unknown): value is WeekStart {
  return typeof value === "string"
    && (WEEK_START_VALUES as readonly string[]).includes(value);
}

export function adaptSettings(raw: unknown): Settings | null {
  if (!raw || typeof raw !== "object") return null;
  const payload = raw as RawSettingsPayload;
  if (
    typeof payload.email !== "string"
    || typeof payload.currency !== "string"
    || typeof payload.locale !== "string"
    || typeof payload.theme !== "string"
    || typeof payload.version !== "number"
    || typeof payload.updated_at !== "string"
    || !isWeekStart(payload.week_start)
  ) {
    return null;
  }
  return {
    email: payload.email,
    displayName: toStringOrNull(payload.display_name),
    currency: payload.currency,
    locale: payload.locale,
    weekStart: payload.week_start,
    efMultiplier: toFiniteInt(payload.ef_multiplier),
    dependentsCount: toFiniteInt(payload.dependents_count),
    theme: payload.theme,
    version: payload.version,
    updatedAt: payload.updated_at,
  };
}

/**
 * Extract the strong ETag value (`"<version>"`) from a `Headers`
 * instance, returning `null` when the header is missing or malformed.
 * The BE always sets the header on `/settings` so a `null` return
 * signals a server regression rather than a normal condition.
 */
export function readEtagHeader(headers: Headers): string | null {
  const raw = headers.get("ETag");
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  if (trimmed.length === 0) return null;
  // Strong ETag form: `"<version>"`. Tolerate unquoted form for
  // defensive parsing — the wire contract quotes the value but a
  // proxy that strips quotes shouldn't sink the optimistic-concurrency
  // round-trip.
  if (trimmed.startsWith("\"") && trimmed.endsWith("\"")) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

/**
 * `GET /settings` — fetch the caller's profile + preferences +
 * version token. Returns both the adapted body and the strong ETag
 * from the response header so the FE can round-trip the version on
 * the next PATCH without a separate read of `response.headers`.
 *
 * Returns `null` for `settings` when the payload is missing/malformed
 * (the page renders the error-retry path in that case).
 *
 * Accepts an `AbortSignal` so the caller can drop in-flight requests
 * when a newer load starts (race condition guard, see sub-0002-03
 * Cek 5).
 */
export async function fetchSettings(
  options: { signal?: AbortSignal } = {},
): Promise<SettingsResponse> {
  const response = await apiRequestWithHeaders<unknown>("/settings", {
    signal: options.signal,
  });
  return {
    settings: adaptSettings(response.data) as Settings,
    etag: readEtagHeader(response.headers),
  };
}

export interface SettingsUpdatePayload {
  displayName?: string | null;
  weekStart?: WeekStart;
  efMultiplier?: number;
}

interface RawSettingsUpdatePayload {
  display_name?: string | null;
  week_start?: WeekStart;
  ef_multiplier?: number;
}

function toWirePayload(payload: SettingsUpdatePayload): RawSettingsUpdatePayload {
  const out: RawSettingsUpdatePayload = {};
  if (payload.displayName !== undefined) out.display_name = payload.displayName;
  if (payload.weekStart !== undefined) out.week_start = payload.weekStart;
  if (payload.efMultiplier !== undefined) out.ef_multiplier = payload.efMultiplier;
  return out;
}

/**
 * `PATCH /settings` — partial update of the caller's settings row.
 *
 * `version` is the value the FE round-tripped from the last GET.
 * The BE echoes it as the `If-Match` request header; a stale value
 * returns `412 Precondition Failed` and the FE refetches + retries
 * rather than silently clobbering either side of a 2-tab race (AC
 * (e)). The BE also accepts the unquoted form; the wire contract is
 * quoted per RFC 7232.
 *
 * `etag` is the optional strong ETag from the last GET — when set
 * the FE sends it back so the BE can resolve the `*` wildcard
 * against the current version without parsing the body. When
 * `etag` is null we fall back to `version` so a missing header
 * still round-trips the optimistic-concurrency token.
 *
 * Returns the freshly-persisted `Settings` plus the new `ETag` from
 * the response. Throws `ApiError` with `status === 412` on a stale
 * echo so the caller can branch on the error without parsing the
 * response body.
 */
export async function updateSettings(
  payload: SettingsUpdatePayload,
  options: { version: number; etag?: string | null; signal?: AbortSignal },
): Promise<SettingsResponse> {
  if (!Number.isFinite(options.version) || options.version < 1) {
    throw new ApiError(
      400,
      "Versi settings tidak valid. Muat ulang halaman lalu coba lagi.",
    );
  }
  const token = options.etag && options.etag.length > 0
    ? options.etag
    : String(options.version);
  const response = await apiRequestWithHeaders<unknown>("/settings", {
    method: "PATCH",
    body: toWirePayload(payload),
    headers: { "If-Match": `"${token}"` },
    signal: options.signal,
  });
  const settings = adaptSettings(response.data);
  if (settings === null) {
    throw new ApiError(200, "Respons pembaruan settings tidak dikenali.");
  }
  return {
    settings,
    etag: readEtagHeader(response.headers),
  };
}

/**
 * Map any thrown value to a friendly Indonesian message. Mirrors
 * the pattern used by `formatGoalApiError` / `formatAccountApiError`
 * so the error UI across the app stays consistent.
 *
 * The settings page branches separately on `412` (`refreshAndPrompt`)
 * so the generic banner doesn't fire for the "your edit lost the
 * race" case — but the formatter still maps it to a sensible
 * message for the caller's debug log / fallback render.
 */
export function formatSettingsApiError(error: unknown, fallback: string): string {
  if (error instanceof ApiError) {
    if (error.status === 401 || error.status === 403) {
      return "Sesi kamu sudah berakhir. Masuk lagi untuk memuat pengaturan.";
    }
    if (error.status === 404) {
      return "Pengaturan tidak ditemukan.";
    }
    if (error.status === 412) {
      return "Pengaturan telah berubah di sesi lain. Muat ulang lalu coba lagi.";
    }
    if (error.status === 422) {
      return error.message || "Data pengaturan belum valid.";
    }
    if (error.status >= 500) {
      return "Server sedang bermasalah. Coba lagi beberapa saat.";
    }
    return error.message || fallback;
  }
  if (error instanceof Error && error.message.startsWith("Respons")) {
    return error.message;
  }
  return fallback;
}

/* -------------------------------------------------------------------------- *
 * Validation error mapping                                                   *
 * -------------------------------------------------------------------------- *
 *
 * Mirrors the per-field 422 → form-error pipeline used by
 * `goal-client.ts` and `account-client.ts`. The settings schema
 * enforces ``extra="forbid"`` so a stray key surfaces as 422 before
 * the route runs — we keep the mapping generic so any future
 * settings field can plug in without touching the form layer.
 */

export const SETTINGS_FORM_FIELDS = [
  "displayName",
  "weekStart",
  "efMultiplier",
] as const;
export type SettingsFormField = (typeof SETTINGS_FORM_FIELDS)[number];

export type SettingsFormErrors = Partial<Record<SettingsFormField, string>> &
  Record<string, string | undefined>;

export interface ExtractedSettingsValidationError {
  fieldErrors: SettingsFormErrors;
  generalErrors: string[];
}

function snakeToSettingsField(snake: string): SettingsFormField | null {
  switch (snake) {
    case "display_name":
      return "displayName";
    case "week_start":
      return "weekStart";
    case "ef_multiplier":
      return "efMultiplier";
    default:
      return null;
  }
}

export function extractSettingsValidationError(
  error: unknown,
): ExtractedSettingsValidationError | null {
  if (!(error instanceof ApiError) || error.status !== 422) {
    return null;
  }

  const fieldErrors: SettingsFormErrors = {};
  const generalErrors: string[] = [];

  const body = error.body;
  const detail = body && typeof body === "object" ? (body as { detail?: unknown }).detail : null;
  const list = Array.isArray(detail) ? detail : null;

  if (!list) {
    return null;
  }

  for (const entry of list) {
    if (!entry || typeof entry !== "object") continue;
    const msg = typeof (entry as { msg?: unknown }).msg === "string"
      ? (entry as { msg: string }).msg
      : null;
    if (!msg) continue;

    const loc = Array.isArray((entry as { loc?: unknown }).loc)
      ? (entry as { loc: unknown[] }).loc
      : [];
    const fieldSegments = loc.filter(
      (segment): segment is string => typeof segment === "string" && segment !== "body",
    );

    if (fieldSegments.length === 0) {
      generalErrors.push(msg);
      continue;
    }

    const snakeField = fieldSegments[fieldSegments.length - 1];
    const camelField = snakeToSettingsField(snakeField);
    if (camelField) {
      const existing = fieldErrors[camelField];
      fieldErrors[camelField] = existing ? `${existing} ${msg}` : msg;
    } else {
      generalErrors.push(msg);
    }
  }

  return { fieldErrors, generalErrors };
}

/** Re-export so import sites don't have to drill into `client.ts`. */
export type { ApiErrorBody };