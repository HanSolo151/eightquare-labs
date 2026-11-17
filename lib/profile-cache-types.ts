import type { FlaggedMove, GameEval, ParsedGame } from "@/types";
import type { BiasData } from "@/lib/bias/getBiasData";

export interface ProfileFlaggedMoment extends Pick<
  FlaggedMove,
  "ply" | "moveNumber" | "san" | "color" | "flagType" | "severity" | "cpLoss" | "mateBefore" | "mateAfter" | "gamePhase" | "explanation"
> {
  /** Lichess's stable external game identifier. */
  gameId: string;
  /** Internal database ID used by authenticated dashboard replay routes. */
  internalGameId: string;
  opponentUsername: string;
  openingName: string | null;
  openingEco: string | null;
  result: ParsedGame["result"];
  playedAt: number | null;
}

export interface UserProfileCache {
  userId: string;
  flaggedMoments: ProfileFlaggedMoment[];
  patternLabels: Record<string, Array<{ gameId: string; ply: number }>>;
  heatmapData: BiasData;
  nemesisSquare: string | null;
  lastSyncedAt: number | null;
  pendingNewGamesCount: number;
}

export interface PgnSessionResult {
  version: 2;
  id: string;
  pgn: string;
  headers: Record<string, string>;
  moves: string[];
  gameEval: GameEval;
  flaggedMoments: FlaggedMove[];
  analyzedAt: number;
}
