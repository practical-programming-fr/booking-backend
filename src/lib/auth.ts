// Service-principal auth for the external FlyLo Ops Agent.
//
// This is an ADDITIVE authentication path. Browser callers keep identifying
// themselves with the BOOKING_SESSION_HEADER (a per-session UUID); nothing
// about that flow changes here. The ops agent instead presents a bearer token
// (OPS_AGENT_TOKEN) and is treated as a distinct SERVICE PRINCIPAL.
//
// Guarding rules for the agent-facing ops-disruption endpoints:
//   * OPS_AGENT_TOKEN set          -> require a matching Bearer token.
//   * OPS_AGENT_TOKEN unset, dev   -> allow (local dev works without a token).
//   * OPS_AGENT_TOKEN unset, prod  -> deny (production must configure a token).
//
// The token comparison is constant-time and the token value is never logged.

import { timingSafeEqual } from "node:crypto";
import type { Context, MiddlewareHandler } from "hono";
import { loadEnv } from "../env.js";

const BEARER_PREFIX = "Bearer ";

/**
 * Constant-time string comparison. Returns false for length mismatches without
 * leaking timing beyond the length, which is acceptable for opaque tokens.
 */
export function constantTimeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a, "utf8");
  const bufB = Buffer.from(b, "utf8");
  if (bufA.length !== bufB.length) {
    return false;
  }
  return timingSafeEqual(bufA, bufB);
}

/**
 * Extract the presented bearer token from the Authorization header, or null
 * when the header is missing or not a bearer credential.
 */
export function bearerTokenFrom(c: Context): string | null {
  const header = c.req.header("authorization");
  if (!header || !header.startsWith(BEARER_PREFIX)) {
    return null;
  }
  const token = header.slice(BEARER_PREFIX.length).trim();
  return token.length > 0 ? token : null;
}

/**
 * True when the request presents the configured ops-agent bearer token. Always
 * false when OPS_AGENT_TOKEN is unset, so callers can distinguish "verified
 * service principal" from "dev fallthrough".
 */
export function isServicePrincipal(c: Context): boolean {
  const token = loadEnv().OPS_AGENT_TOKEN;
  if (!token) {
    return false;
  }
  const presented = bearerTokenFrom(c);
  if (!presented) {
    return false;
  }
  return constantTimeEqual(presented, token);
}

export type OpsPrincipal = "service" | "dev";

/**
 * Hono middleware that gates the ops-disruption endpoints. On success it stamps
 * `c.set("opsPrincipal", ...)` so handlers can tell a verified service call
 * ("service") apart from an unauthenticated local-dev call ("dev").
 */
export function requireOpsAgent(): MiddlewareHandler {
  return async (c, next) => {
    const env = loadEnv();
    if (!env.OPS_AGENT_TOKEN) {
      if (env.NODE_ENV === "production") {
        return c.json(
          {
            error: {
              message: "Ops agent access is not configured on this deployment",
              status: 503,
            },
          },
          503,
        );
      }
      c.set("opsPrincipal", "dev");
      return next();
    }
    if (!isServicePrincipal(c)) {
      return c.json(
        { error: { message: "Unauthorized", status: 401 } },
        401,
      );
    }
    c.set("opsPrincipal", "service");
    return next();
  };
}
