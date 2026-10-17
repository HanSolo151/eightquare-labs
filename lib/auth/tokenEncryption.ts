import { createCipheriv, createDecipheriv, createHmac, randomBytes } from "node:crypto";

const TOKEN_PREFIX = "v1";

function encryptionKey(): Buffer {
  const authSecret = process.env.AUTH_SECRET;
  if (!authSecret) throw new Error("AUTH_SECRET is required to encrypt OAuth tokens");

  // Domain-separate this key from Auth.js signing/encryption uses. Keep
  // AUTH_SECRET stable while encrypted provider tokens need to be readable.
  return createHmac("sha256", authSecret)
    .update("eightsquare-labs:lichess-oauth-token:v1")
    .digest();
}

export function encryptOAuthToken(token: string | null | undefined): string | null {
  if (!token) return null;

  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", encryptionKey(), iv);
  const ciphertext = Buffer.concat([cipher.update(token, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [TOKEN_PREFIX, iv.toString("base64url"), tag.toString("base64url"), ciphertext.toString("base64url")].join(".");
}

export function decryptOAuthToken(value: string | null): string | null {
  if (!value) return null;

  const [version, ivPart, tagPart, ciphertextPart, extra] = value.split(".");
  if (version !== TOKEN_PREFIX || !ivPart || !tagPart || !ciphertextPart || extra !== undefined) {
    throw new Error("Stored OAuth token is not in the supported encrypted format");
  }

  const decipher = createDecipheriv(
    "aes-256-gcm",
    encryptionKey(),
    Buffer.from(ivPart, "base64url")
  );
  decipher.setAuthTag(Buffer.from(tagPart, "base64url"));
  return Buffer.concat([
    decipher.update(Buffer.from(ciphertextPart, "base64url")),
    decipher.final(),
  ]).toString("utf8");
}
