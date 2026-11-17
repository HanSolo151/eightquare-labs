import { connection } from "next/server";
import { redirect } from "next/navigation";
import GamePanel from "@/components/board/GamePanel";
import { auth } from "@/lib/auth";
import { getSessionUserId } from "@/lib/auth/session";

export const instant = false;

export default async function Page() {
  await connection();
  const session = await auth();
  if (session?.user) redirect("/dashboard/home");
  return (
    <GamePanel
      authenticatedUsername={session?.user?.name ?? null}
      authenticatedUserId={getSessionUserId(session) ?? null}
    />
  );
}
