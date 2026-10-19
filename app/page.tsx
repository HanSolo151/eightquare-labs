import GamePanel from "@/components/board/GamePanel";
import { auth } from "@/lib/auth";
import { getSessionUserId } from "@/lib/auth/session";

export const instant = false;

export default async function Page() {
  const session = await auth();
  return (
    <GamePanel
      authenticatedUsername={session?.user?.name ?? null}
      authenticatedUserId={getSessionUserId(session) ?? null}
    />
  );
}
