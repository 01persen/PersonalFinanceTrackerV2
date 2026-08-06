import { ApiError, tokenStore } from "@/lib/api/client";
import { extractFilenameFromDisposition } from "@/lib/download";
import { API_BASE_URL, API_V1_PREFIX } from "@/lib/env";

/**
 * Export client (sub-0008-05 — FE buttons for CSV / JSON / ZIP).
 *
 * Mirrors the `apiRequest` shape in `client.ts` but specialised for
 * binary downloads: a successful response is a `Blob`, and the
 * filename is sourced from the `Content-Disposition` response header
 * so the FE doesn't have to know the BE's date convention.
 *
 * The CSV / JSON / ZIP endpoints each set
 * `Content-Disposition: attachment; filename="..."` per the BE
 * contract documented in `apps/api/src/app/api/v1/export.py` and
 * `export_json.py`. The FE honours whatever the BE chooses so the
 * two sides stay in sync.
 */

export interface ExportBlobResult {
  blob: Blob;
  filename: string | null;
}

export interface FetchExportOptions {
  signal?: AbortSignal;
}

function buildUrl(path: string): string {
  return `${API_BASE_URL}${API_V1_PREFIX}${path}`;
}

/**
 * Fetch a binary export endpoint.
 *
 * Throws `ApiError` on:
 * - 401 / 403 → caller should redirect to `/login` and surface a
 *   "Sesi berakhir" toast. We deliberately do NOT auto-redirect here
 *   so the component can decide whether the redirect is appropriate
 *   (e.g. skip if the user is on a guest page that never exported).
 * - 5xx / network → caller surfaces a generic "Gagal mengunduh, coba
 *   lagi" toast so the button stays enabled for a retry.
 * - AbortError → re-thrown as-is so the caller can distinguish a
 *   user-initiated cancellation from a transport failure.
 */
export async function fetchExportBlob(
  path: string,
  options: FetchExportOptions = {},
): Promise<ExportBlobResult> {
  const headers: Record<string, string> = {
    Accept: "*/*",
  };
  const accessToken = tokenStore.getAccessToken();
  if (accessToken) {
    headers.Authorization = `Bearer ${accessToken}`;
  }

  let response: Response;
  try {
    response = await fetch(buildUrl(path), {
      method: "GET",
      headers,
      signal: options.signal,
    });
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") {
      throw error;
    }
    throw new ApiError(
      0,
      "Tidak bisa menghubungi server. Periksa koneksi lalu coba lagi.",
    );
  }

  if (!response.ok) {
    let message = response.statusText || `HTTP ${response.status}`;
    if (response.status === 401 || response.status === 403) {
      message = "Sesi berakhir, silakan login ulang.";
    } else if (response.status >= 500) {
      message = "Server sedang bermasalah. Coba lagi beberapa saat.";
    }
    throw new ApiError(response.status, message);
  }

  const blob = await response.blob();
  const filename = extractFilenameFromDisposition(
    response.headers.get("Content-Disposition"),
  );
  return { blob, filename };
}
