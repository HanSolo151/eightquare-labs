-- Previous auth code wrote provider tokens directly to these columns.
-- New tokens are encrypted by the application; clear any legacy plaintext
-- values so credentials do not remain stored unencrypted.
UPDATE "User"
SET "accessToken" = NULL,
    "refreshToken" = NULL,
    "tokenExpiresAt" = NULL
WHERE "accessToken" IS NOT NULL
   OR "refreshToken" IS NOT NULL
   OR "tokenExpiresAt" IS NOT NULL;
