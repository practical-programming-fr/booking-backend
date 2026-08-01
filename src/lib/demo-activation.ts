import { createHash, randomBytes } from "node:crypto";

export function hashDemoActivationToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export function createDemoActivationToken(): {
  token: string;
  tokenHash: string;
} {
  const token = randomBytes(32).toString("base64url");
  return {
    token,
    tokenHash: hashDemoActivationToken(token),
  };
}
