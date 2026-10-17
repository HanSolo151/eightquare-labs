import type { Session } from "next-auth";

type SessionUser = Session["user"] & { id?: string; plan?: string };

export function getSessionUserId(session: Session | null): string | undefined {
  return (session?.user as SessionUser | undefined)?.id;
}

export function getSessionPlan(session: Session | null): string {
  return (session?.user as SessionUser | undefined)?.plan ?? "free";
}
