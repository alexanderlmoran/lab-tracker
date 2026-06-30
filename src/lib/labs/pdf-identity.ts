// Pull patient identity (DOB, sex, name) out of a lab-result PDF's extracted
// text. Lab reports print a header block like:
//   Name: AVVA STIMLER
//   Date of Birth: 11-19-2019
//   Biological Sex: Female
// The exact labels/separators vary by lab, so the matchers are deliberately
// lenient. Used to close DOB/sex gaps from the most authoritative source we
// have (the result itself) — at scraped-result attach time and in the backfill.
// Pair DOB writes with a name cross-check (see nameLooksLike) so a wrong-patient
// PDF can't poison a case's DOB.

/** Normalize a raw date token to ISO YYYY-MM-DD, or null if implausible. US lab
 *  reports are MM/DD/YYYY; a 4-digit leading group is treated as YYYY-MM-DD. */
function normalizeDob(raw: string): string | null {
  const parts = raw.split(/[/.\-]/).map((s) => s.trim());
  if (parts.length !== 3) return null;
  let y: string, mo: string, d: string;
  if (parts[0].length === 4) {
    [y, mo, d] = parts; // YYYY-MM-DD
  } else {
    [mo, d, y] = parts; // MM-DD-YYYY (US)
  }
  const yy = Number(y);
  const mm = Number(mo);
  const dd = Number(d);
  if (!Number.isInteger(yy) || !Number.isInteger(mm) || !Number.isInteger(dd)) return null;
  if (yy < 1900 || yy > 2100 || mm < 1 || mm > 12 || dd < 1 || dd > 31) return null;
  return `${yy}-${String(mm).padStart(2, "0")}-${String(dd).padStart(2, "0")}`;
}

const DATE_TOKEN =
  "([0-3]?\\d[/.\\-][0-3]?\\d[/.\\-](?:19|20)\\d\\d|(?:19|20)\\d\\d[/.\\-][0-1]?\\d[/.\\-][0-3]?\\d)";
const DOB_RE = new RegExp(
  `(?:date\\s*of\\s*birth|d\\.?o\\.?b\\.?|birth\\s*date|birthdate)\\s*[:\\-]?\\s*${DATE_TOKEN}`,
  "i",
);

/** First DOB found next to a birth-date label, as ISO YYYY-MM-DD, or null. */
export function extractDobFromText(text: string): string | null {
  const m = text.match(DOB_RE);
  if (!m) return null;
  return normalizeDob(m[1]);
}

/** "M" / "F" from a sex/gender label, or null. A bare single letter is trusted
 *  only right after a colon/dash ("Sex: F"); otherwise require the full word
 *  ("Biological Sex Female") so a stray "Gender … m…" can't mis-capture. */
export function extractSexFromText(text: string): "M" | "F" | null {
  const m =
    text.match(/(?:biological\s*sex|sex|gender)\s*[:\-]\s*(male|female|m|f)\b/i) ??
    text.match(/(?:biological\s*sex|sex|gender)\s+(male|female)\b/i);
  if (!m) return null;
  return /^m/i.test(m[1]) ? "M" : "F";
}

/** The "Name:" value printed on the report, or null — for the wrong-patient
 *  cross-check before trusting the report's DOB. */
export function extractReportNameFromText(text: string): string | null {
  // Capture only WITHIN the line (no \s in the class — it would run past the
  // name into the next line's "Date of Birth", breaking the last-name guard).
  const m = text.match(/(?:patient\s*name|\bname)\s*[:\-][ \t]*([A-Za-z][A-Za-z'`. \-]{1,60})/i);
  if (!m) return null;
  return m[1].replace(/\s+/g, " ").trim() || null;
}

/** Identity check guarding a DOB write so we never copy a DOB off a PDF printed
 *  for someone else. Last names must match; when BOTH names carry a first name,
 *  the first names must match too (full or initial) — last-name-only would let a
 *  same-surname sibling slip through (Leo vs Avva Stimler → both "stimler"). */
export function nameLooksLike(a: string | null | undefined, b: string | null | undefined): boolean {
  const parse = (raw: string) => {
    const n = raw.toLowerCase().replace(/[^a-z,\s]/g, " ").replace(/\s+/g, " ").trim();
    if (n.includes(",")) {
      const [last, rest = ""] = n.split(",");
      return { first: rest.trim().split(/\s+/)[0] ?? "", last: last.trim() };
    }
    const toks = n.split(/\s+/).filter(Boolean);
    return { first: toks[0] ?? "", last: toks[toks.length - 1] ?? "" };
  };
  const pa = parse(a ?? "");
  const pb = parse(b ?? "");
  if (!pa.last || !pb.last || pa.last !== pb.last) return false;
  if (pa.first && pb.first) return pa.first === pb.first || pa.first[0] === pb.first[0];
  return true;
}
