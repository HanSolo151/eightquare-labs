ALTER TABLE "FlaggedMove"
  ALTER COLUMN "cpLoss" DROP NOT NULL,
  ADD COLUMN "mateBefore" INTEGER,
  ADD COLUMN "mateAfter" INTEGER;

UPDATE "FlaggedMove" AS flag
SET
  "mateBefore" = NULLIF(evaluation."points" -> flag."ply" ->> 'mateBefore', 'null')::INTEGER,
  "mateAfter" = NULLIF(evaluation."points" -> flag."ply" ->> 'mateAfter', 'null')::INTEGER,
  "cpLoss" = NULL,
  "severity" = 'high',
  "severityBreakdown" = (
    COALESCE(flag."severityBreakdown"::JSONB, '{}'::JSONB) ||
    jsonb_build_object('evalLoss', 0, 'mateTransition', true)
  )::JSON,
  "causality" = (
    COALESCE(flag."causality"::JSONB, '{}'::JSONB) ||
    jsonb_build_object('worstFollowingCpLoss', NULL)
  )::JSON,
  "explanation" = CASE
    WHEN NULLIF(evaluation."points" -> flag."ply" ->> 'mateAfter', 'null')::INTEGER < 0
      THEN 'This move allows a forced mate against you in ' ||
        ABS(NULLIF(evaluation."points" -> flag."ply" ->> 'mateAfter', 'null')::INTEGER)::TEXT ||
        '. The position did not recover by the end of the game.'
    WHEN NULLIF(evaluation."points" -> flag."ply" ->> 'mateBefore', 'null')::INTEGER > 0
      THEN 'This move gives up a forced mate in ' ||
        NULLIF(evaluation."points" -> flag."ply" ->> 'mateBefore', 'null')::INTEGER::TEXT || '.'
    ELSE 'The engine reported a forced-mate evaluation change.'
  END
FROM "GameEval" AS evaluation
WHERE evaluation."gameId" = flag."gameId"
  AND flag."evalConfidence" IN ('mate_only', 'degraded_mate_only');
