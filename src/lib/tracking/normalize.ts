// Normalise the raw string that came out of a barcode scan into the actual
// tracking number. Shipping labels print TWO barcodes most of the time:
//
//   • a small "tracking #" barcode that's just the 12-digit FedEx number, and
//   • a giant 34-character "FedEx 96" / SSCC-style barcode at the bottom of
//     the label that encodes the same tracking number along with routing
//     and SSCC application identifiers.
//
// Scanners — especially phone-camera ones — almost always lock onto the big
// 96-format barcode because it's larger. The last 12 digits of that 34-digit
// string ARE the tracking number, so we slice them out. The user can scan
// either barcode and we land on the same tracking number.

const FEDEX_EXPRESS_LEN = 12;
const FEDEX_96_LEN = 34;
const FEDEX_GROUND_SSCC_LEN = 22; // newer "00…" SSCC-18 + AI prefix

/** Return just the tracking-number portion of whatever was scanned. Falls
 * back to the trimmed raw string when the format isn't recognised — the
 * downstream FedEx adapter will reject obviously bad inputs anyway. */
export function normalizeScannedTracking(raw: string): string {
  const cleaned = raw.replace(/[\s-]/g, "").trim();
  if (!cleaned) return cleaned;

  // FedEx 96 / Ground full-label barcode: 34 all-digit string. Last 12 are
  // the tracking number. Example we've seen:
  //   1002289301960003345800487953992934 → 487953992934
  if (cleaned.length === FEDEX_96_LEN && /^\d+$/.test(cleaned)) {
    return cleaned.slice(-FEDEX_EXPRESS_LEN);
  }

  // FedEx Ground SSCC variant (22 digits starting with "00"). Last 12 again.
  if (
    cleaned.length === FEDEX_GROUND_SSCC_LEN &&
    cleaned.startsWith("00") &&
    /^\d+$/.test(cleaned)
  ) {
    return cleaned.slice(-FEDEX_EXPRESS_LEN);
  }

  // Already a clean 12-digit FedEx Express tracking number.
  if (cleaned.length === FEDEX_EXPRESS_LEN && /^\d+$/.test(cleaned)) {
    return cleaned;
  }

  // UPS 1Z + 16 alphanumeric chars. Returned as-is (the small barcode usually
  // wins, but if a scanner reads the routing barcode we'd see "1Z…" twice).
  // Nothing to slice.
  return cleaned;
}
