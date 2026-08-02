import type postgres from "postgres";
import { isDemoOutageActiveForSession } from "./demo-outage.js";
import { fareAdjustmentEnabled } from "./ops.js";

export type PricingOutageLookups = {
  globalEnabled: () => Promise<boolean>;
  sessionEnabled: (bookingSessionId: string) => Promise<boolean>;
};

export async function resolvePricingOutage(
  bookingSessionId: string | null,
  lookups: PricingOutageLookups,
): Promise<boolean> {
  if (await lookups.globalEnabled()) {
    return true;
  }
  if (!bookingSessionId) {
    return false;
  }
  return lookups.sessionEnabled(bookingSessionId);
}

export async function pricingOutageEnabled(
  sql: postgres.Sql,
  bookingSessionId: string | null,
): Promise<boolean> {
  return resolvePricingOutage(bookingSessionId, {
    globalEnabled: () => fareAdjustmentEnabled(sql),
    sessionEnabled: (sessionId) =>
      isDemoOutageActiveForSession(sql, sessionId),
  });
}
