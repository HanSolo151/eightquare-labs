// In-memory stand-in for @/lib/prisma, scoped to this script by tsconfig.
type UserRow = {
  id: string;
  username: string;
  lastSyncedAt: Date | null;
  lastGameCreatedAt: Date | null;
};

type GameRow = { id?: string; userId: string; lichessGameId: string; [key: string]: unknown };

const users = new Map<string, UserRow>();
const games = new Map<string, GameRow>();

export function __seedUser(user: UserRow) {
  users.set(user.id, { ...user });
}

export function __reset() {
  users.clear();
  games.clear();
}

export function __gameCount(userId: string) {
  return [...games.values()].filter((game) => game.userId === userId).length;
}

function gameKey(game: Pick<GameRow, "userId" | "lichessGameId">) {
  return `${game.userId}:${game.lichessGameId}`;
}

export const prisma = {
  user: {
    findUnique: async ({ where: { id } }: { where: { id: string } }) =>
      users.has(id) ? { ...users.get(id)! } : null,
    update: async ({ where: { id }, data }: {
      where: { id: string };
      data: Partial<UserRow>;
      select?: { lastGameCreatedAt?: boolean };
    }) => {
      const existing = users.get(id);
      if (!existing) throw new Error("user not found in fake prisma");
      const updated = { ...existing, ...data };
      users.set(id, updated);
      return { ...updated };
    },
  },
  game: {
    count: async ({ where: { userId } }: { where: { userId: string } }) => __gameCount(userId),
    createMany: async ({
      data,
      skipDuplicates,
    }: {
      data: GameRow[];
      skipDuplicates?: boolean;
    }) => {
      let count = 0;
      for (const row of data) {
        const key = gameKey(row);
        if (games.has(key)) {
          if (!skipDuplicates) throw new Error("unique constraint failed on userId + lichessGameId");
          continue;
        }
        games.set(key, { ...row, id: row.id ?? `internal-${games.size + 1}` });
        count++;
      }
      return { count };
    },
  },
  $transaction: async (operations: Promise<unknown>[]) => Promise.all(operations),
};
