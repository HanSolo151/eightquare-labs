import { createHash, randomBytes } from "node:crypto";
import { MATCHING_CONFIG } from "@/config/matching";

export function createMomentLinkToken(now = new Date()) {
  const token = randomBytes(32).toString("base64url");
  const tokenHash = createHash("sha256").update(token).digest("hex");
  const expiresAt = new Date(now.getTime() + MATCHING_CONFIG.MOMENT_TOKEN_TTL_DAYS * 24 * 60 * 60 * 1000);
  return { token, tokenHash, expiresAt };
}

export function hashMomentLinkToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}
