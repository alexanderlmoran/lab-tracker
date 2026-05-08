import { createClient, type SupabaseClient } from "@supabase/supabase-js";

// Untyped client. Schema typing comes from `src/lib/types.ts` which we cast
// results against at the boundary. Generate full types later via
// `npx supabase gen types typescript --project-id oohgjlatfkdckopmbpcc` if
// the manual types start to drift.
type AdminClient = SupabaseClient;

let cached: AdminClient | null = null;

// Server-only client using the secret key. Bypasses RLS. NEVER import this
// from a Client Component — the secret key would leak to the browser bundle.
export function getSupabaseAdmin(): AdminClient {
  if (cached) return cached;
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const secret = process.env.SUPABASE_SECRET_KEY;
  if (!url || !secret) {
    throw new Error(
      "SUPABASE_SECRET_KEY (or NEXT_PUBLIC_SUPABASE_URL) is not set",
    );
  }
  cached = createClient(url, secret, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  return cached;
}
