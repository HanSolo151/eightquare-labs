import { createCipheriv, createDecipheriv, createHmac, randomBytes } from "node:crypto";

const TOKEN_PREFIX = "v1";

function encryptionKey(authSecret: string | undefined): Buffer {
  if (!authSecret) throw new Error("AUTH_SECRET is required to encrypt OAuth tokens");
  // Domain-separate this key from Auth.js signing/encryption uses. Keep
  // the current secret first; AUTH_SECRET_PREVIOUS supports planned rotation.
  return createHmac("sha256", authSecret)
    .update("eightsquare-labs:lichess-oauth-token:v1")
    .digest();
}

export function encryptOAuthToken(token: string | null | undefined): string | null {
  if (!token) return null;

  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", encryptionKey(process.env.AUTH_SECRET), iv);
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

  const secrets = [process.env.AUTH_SECRET, process.env.AUTH_SECRET_PREVIOUS]
    .filter((secret): secret is string => Boolean(secret));
  for (const secret of secrets) {
    try {
      const decipher = createDecipheriv(
        "aes-256-gcm",
        encryptionKey(secret),
        Buffer.from(ivPart, "base64url")
      );
      decipher.setAuthTag(Buffer.from(tagPart, "base64url"));
      return Buffer.concat([
        decipher.update(Buffer.from(ciphertextPart, "base64url")),
        decipher.final(),
      ]).toString("utf8");
    } catch {
      // The next configured key may be the one that encrypted this token.
    }
  }
  throw new Error("OAuth token could not be decrypted with AUTH_SECRET or AUTH_SECRET_PREVIOUS");
}
