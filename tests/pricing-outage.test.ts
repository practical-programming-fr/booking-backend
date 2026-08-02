import { describe, expect, it, vi } from "vitest";
import { resolvePricingOutage } from "../src/domain/pricing-outage.js";

const brokenSession = "11111111-1111-4111-8111-111111111111";
const healthySession = "22222222-2222-4222-8222-222222222222";

describe("scoped pricing outages", () => {
  it("fails only the activated browser session", async () => {
    const activeSessions = new Set([brokenSession]);
    const lookups = {
      globalEnabled: vi.fn(async () => false),
      sessionEnabled: vi.fn(
        async (sessionId: string) => activeSessions.has(sessionId),
      ),
    };

    await expect(resolvePricingOutage(brokenSession, lookups)).resolves.toBe(true);
    await expect(resolvePricingOutage(healthySession, lookups)).resolves.toBe(false);
    await expect(resolvePricingOutage(null, lookups)).resolves.toBe(false);
  });

  it("recovers one browser without changing another active browser", async () => {
    const activeSessions = new Set([brokenSession, healthySession]);
    const lookups = {
      globalEnabled: vi.fn(async () => false),
      sessionEnabled: vi.fn(
        async (sessionId: string) => activeSessions.has(sessionId),
      ),
    };

    activeSessions.delete(brokenSession);

    await expect(resolvePricingOutage(brokenSession, lookups)).resolves.toBe(false);
    await expect(resolvePricingOutage(healthySession, lookups)).resolves.toBe(true);
  });

  it("keeps the global outage as a separate all-session control", async () => {
    const lookups = {
      globalEnabled: vi.fn(async () => true),
      sessionEnabled: vi.fn(async () => false),
    };

    await expect(resolvePricingOutage(healthySession, lookups)).resolves.toBe(true);
    expect(lookups.sessionEnabled).not.toHaveBeenCalled();
  });
});
