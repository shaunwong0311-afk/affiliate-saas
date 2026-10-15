/**
 * Browser "save this as a file" helpers. Used for the payout-file export (which the API
 * serves as `text/csv` behind the auth header, so it cannot be a plain link) and for the
 * CSV import templates.
 */

/** Trigger a browser download of `blob` under `filename`. */
export function saveBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.rel = "noopener";
  a.style.display = "none";
  document.body.appendChild(a);
  a.click();
  a.remove();
  // Revoke on a later tick: some browsers start the download asynchronously.
  window.setTimeout(() => URL.revokeObjectURL(url), 30_000);
}

export function saveText(text: string, filename: string, mime = "text/csv;charset=utf-8"): void {
  saveBlob(new Blob([text], { type: mime }), filename);
}

/**
 * The filename from a `Content-Disposition` header, or null. Handles both the plain
 * (`filename="x.csv"`) and RFC 5987 (`filename*=UTF-8''x.csv`) forms. Path separators are
 * stripped so a server-supplied name can never point outside the download folder.
 */
export function filenameFromDisposition(header: string | null | undefined): string | null {
  if (!header) return null;
  let name: string | null = null;
  const star = /filename\*\s*=\s*([^;]+)/i.exec(header);
  if (star) {
    const raw = star[1]!.trim().replace(/^"|"$/g, "");
    const encoded = raw.includes("''") ? raw.slice(raw.indexOf("''") + 2) : raw;
    try {
      name = decodeURIComponent(encoded);
    } catch {
      name = encoded;
    }
  }
  if (!name) {
    const plain = /filename\s*=\s*("([^"]*)"|[^;]+)/i.exec(header);
    if (plain) name = (plain[2] ?? plain[1] ?? "").trim();
  }
  if (!name) return null;
  const safe = name.replace(/[\\/]/g, "_").replace(/[\u0000-\u001f]/g, "").trim();
  return safe || null;
}
