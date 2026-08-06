/**
 * Blob download helper (sub-0008-05).
 *
 * Browser-standard download flow: build a temporary object URL from
 * a `Blob`, click a programmatic `<a download>` link, then revoke the
 * URL. Centralised so every export endpoint (CSV / JSON / ZIP) hits
 * the same code path and the cleanup can't leak.
 */

/**
 * Parse the `filename=...` (or `filename*=UTF-8''...`) value out of a
 * `Content-Disposition` response header. The BE always sets the
 * filename on `/export/transactions.csv|json|backup.zip` per the
 * sub-0008-01/02 contract, so a `null` return is a server regression
 * rather than a normal condition.
 *
 * Handles both quoted (`filename="transactions-2026-08-06.csv"`) and
 * unquoted (`filename=transactions-2026-08-06.csv`) forms so a proxy
 * that strips quotes still surfaces the right filename on the FE.
 * RFC 5987 extended form (`filename*=UTF-8''...`) is decoded.
 */
export function extractFilenameFromDisposition(
  header: string | null | undefined,
): string | null {
  if (typeof header !== "string") return null;
  // Two valid forms:
  //   - `filename="..."` (RFC 2616 quoted, BE contract)
  //   - `filename*=UTF-8''...` (RFC 5987 percent-encoded, future-proof)
  const extMatch = header.match(/filename\*=UTF-8''([^";]+)/i);
  if (extMatch) {
    try {
      const decoded = decodeURIComponent(extMatch[1]);
      return decoded.length > 0 ? decoded : null;
    } catch {
      const raw = extMatch[1].trim();
      return raw.length > 0 ? raw : null;
    }
  }
  const match = header.match(/filename=("?)([^";]+)\1/i);
  if (!match) return null;
  const value = match[2].trim();
  return value.length > 0 ? value : null;
}

interface TriggerDownloadOptions {
  /**
   * Revoke the object URL after the click. Defaults to `true`. Set
   * `false` when the URL is reused (e.g. user re-downloads the same
   * blob) so the revoke doesn't race with the second click.
   */
  revoke?: boolean;
}

/**
 * Trigger a download by programmatically clicking an `<a download>`
 * link. The link is appended to the DOM (required by Firefox +
 * Safari) and removed after the click so the element doesn't leak.
 *
 * `URL.createObjectURL` is the only portable way to deliver a `Blob`
 * to the browser's download manager — `window.open` opens a new tab
 * for some MIME types and `data:` URLs hit size limits on big blobs.
 */
export function triggerDownload(
  url: string,
  filename: string,
  options: TriggerDownloadOptions = {},
): void {
  if (typeof document === "undefined") return;
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  link.rel = "noopener";
  link.style.display = "none";
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  if (options.revoke !== false) {
    // Defer revoke so Safari has a tick to start the download before
    // the URL is invalidated.
    setTimeout(() => URL.revokeObjectURL(url), 0);
  }
}

/**
 * Convenience wrapper that takes a `Blob` and saves it under the
 * given filename. Revokes the object URL after the click.
 */
export function downloadBlob(blob: Blob, filename: string): void {
  if (typeof document === "undefined") return;
  const url = URL.createObjectURL(blob);
  triggerDownload(url, filename);
}
