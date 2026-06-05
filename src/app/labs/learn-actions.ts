"use server";

import { revalidatePath } from "next/cache";
import { requireRole } from "@/lib/auth-guard";
import { invalidateEffectiveCatalogCache } from "@/lib/labs/effective";
import {
  recomputeTurnaroundsCore,
  type LearnTurnaroundsResult,
} from "@/lib/labs/learn-turnarounds-core";
import type { ActionResult } from "@/lib/types";

// Re-exported so existing UI imports (LearnTurnaroundsPanel imports the type
// from "../learn-actions") keep working after the core computation moved to
// @/lib/labs/learn-turnarounds-core.
export type { LearnTurnaroundsResult };

/**
 * Developer-gated server action behind the "Recompute now" button in the
 * Analytics → Reports tab. Delegates the actual recompute to
 * recomputeTurnaroundsCore (shared with the /api/cron/learn-turnarounds cron
 * route), then invalidates the effective-catalog cache and revalidates the UI
 * surfaces that display turnarounds. The cron route does the same recompute on
 * a daily schedule without a human click.
 */
export async function recomputeCatalogTurnaroundsFromHistory(): Promise<
  ActionResult<LearnTurnaroundsResult>
> {
  await requireRole("developer");

  const result = await recomputeTurnaroundsCore();
  if (!result.ok) return result;

  invalidateEffectiveCatalogCache();
  revalidatePath("/labs/analytics"); // turnaround panel now lives in the Analytics → Reports tab
  revalidatePath("/labs/settings");

  return result;
}
