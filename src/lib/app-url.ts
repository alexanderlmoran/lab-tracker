/** Single source of truth for the app's absolute base URL. Used wherever a
 * server-side route needs to emit a link that ends up in someone's inbox or
 * an external system. Explicit env wins so prod doesn't accidentally point
 * at a Vercel preview URL. */
export function appBaseUrl(): string {
  const explicit = process.env.APP_URL?.trim();
  if (explicit) return explicit.replace(/\/+$/, "");
  const vercel = process.env.VERCEL_URL?.trim();
  if (vercel) return `https://${vercel.replace(/\/+$/, "")}`;
  return "http://localhost:3000";
}
