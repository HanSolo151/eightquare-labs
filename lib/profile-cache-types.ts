import type { FlaggedMove, GameEval, ParsedGame } from "@/types";
import type { BiasData } from "@/lib/bias/getBiasData";

export interface ProfileFlaggedMoment extends Pick<
  FlaggedMove,
  "ply" | "moveNumber" | "san" | "color" | "flagType" | "severity" | "cpLoss" | "gamePhase" | "explanation"
> {
  gameId: string;
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
  version: 1;
  id: string;
  pgn: string;
  headers: Record<string, string>;
  moves: string[];
  gameEval: GameEval;
  flaggedMoments: FlaggedMove[];
  analyzedAt: number;
}
