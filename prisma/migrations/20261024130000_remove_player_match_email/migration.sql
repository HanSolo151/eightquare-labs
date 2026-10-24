-- The player-style match feature now runs in the authenticated Wins page.
-- Its former persisted moments and email delivery tables are no longer used.
DROP TABLE IF EXISTS "EmailSendLog";
DROP TABLE IF EXISTS "NotificationPreference";
DROP TABLE IF EXISTS "GameMoment";
