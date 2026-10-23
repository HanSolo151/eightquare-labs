import { MATCHING_CONFIG } from "@/config/matching";
import { prisma } from "@/lib/prisma";
import { selectRerankCandidates } from "./rerankAndSelect";
import { createMomentLinkToken } from "./momentLinkToken";

const DAY = 24 * 60 * 60 * 1000;
const escapeHtml = (value: string) => value.replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#39;" })[char]!);

export type MatchEmailSender = (email: string, momentId: string, score: number, unsubscribeToken: string, now: Date) => Promise<boolean>;

/** Ranks eligible matches and reserves the weekly allowance per user before sending. */
export async function deliverPlayerStyleMatches(now = new Date(), sendEmail: MatchEmailSender = sendMatchEmail) {
  const cutoff = new Date(now.getTime() - MATCHING_CONFIG.RERANK_BACKLOG_DAYS * DAY);
  const expired = await prisma.gameMoment.updateMany({
    where: { status: { in: ["pending", "matched", "queued"] }, createdAt: { lt: cutoff } },
    data: { status: "skipped_capped", sendClaimedAt: null },
  });
  const preferences = await prisma.notificationPreference.findMany({
    where: { vanityMatchOptIn: true, emailAddress: { not: null } },
    select: { userId: true, emailAddress: true, unsubscribeToken: true },
  });
  let sent = 0;
  let failed = 0;

  for (const preference of preferences) {
    // Locking is transaction-scoped and keyed by user. Reserve queued rows in
    // the same transaction as counting sends, so another cron invocation sees
    // those reservations even before the provider call creates send-log rows.
    const claimedCandidates = await prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended(${preference.userId}, 0))::text AS locked`;
      const [moments, sends, reservations, recent] = await Promise.all([
        tx.gameMoment.findMany({
          where: { userId: preference.userId, status: { in: ["matched", "queued"] }, OR: [{ sendClaimedAt: null }, { sendClaimedAt: { lt: new Date(now.getTime() - 10 * 60 * 1000) } }], createdAt: { gte: cutoff }, matchedBigshotId: { not: null }, matchDistance: { not: null } },
          orderBy: { createdAt: "asc" },
          select: { id: true, phase: true, matchedBigshotId: true, matchDistance: true, motifMatch: true, soundness: true, createdAt: true, matchedBigshot: { select: { profiles: { select: { phase: true, sampleSize: true } } } } },
        }),
        tx.emailSendLog.count({ where: { userId: preference.userId, sentAt: { gte: new Date(now.getTime() - MATCHING_CONFIG.RERANK_WINDOW_DAYS * DAY) } } }),
        tx.gameMoment.count({ where: { userId: preference.userId, status: "queued", sendClaimedAt: { gte: new Date(now.getTime() - 10 * 60 * 1000) }, emailSendLog: { is: null } } }),
        tx.emailSendLog.findMany({
          where: { userId: preference.userId, sentAt: { gte: new Date(now.getTime() - MATCHING_CONFIG.VARIETY_LOOKBACK_DAYS * DAY), lt: now } },
          orderBy: { sentAt: "desc" }, take: MATCHING_CONFIG.VARIETY_LOOKBACK_COUNT,
          select: { gameMoment: { select: { matchedBigshotId: true } } },
        }),
      ]);
      const selection = selectRerankCandidates(moments.flatMap((moment) => moment.matchedBigshotId && moment.matchDistance !== null ? [{
        id: moment.id,
        matchedBigshotId: moment.matchedBigshotId,
        matchDistance: moment.matchDistance,
        motifMatch: moment.motifMatch,
        soundness: moment.soundness as "sound" | "unsound_lucky" | "unverified",
        sampleSize: moment.matchedBigshot?.profiles.find((profile) => profile.phase === moment.phase)?.sampleSize ?? 0,
        createdAt: moment.createdAt,
      }] : []), sends + reservations, new Set(recent.flatMap((item) => item.gameMoment.matchedBigshotId ? [item.gameMoment.matchedBigshotId] : [])), now);
      if (selection.expiredIds.length) {
        await tx.gameMoment.updateMany({ where: { id: { in: selection.expiredIds }, userId: preference.userId, status: { in: ["matched", "queued"] } }, data: { status: "skipped_capped", sendClaimedAt: null } });
      }

      const claimed = [];
      for (const candidate of selection.selected) {
        const result = await tx.gameMoment.updateMany({
          where: { id: candidate.id, userId: preference.userId, status: { in: ["matched", "queued"] }, OR: [{ sendClaimedAt: null }, { sendClaimedAt: { lt: new Date(now.getTime() - 10 * 60 * 1000) } }] },
          data: { status: "queued", sendClaimedAt: now, rerankScore: candidate.rerankScore },
        });
        if (result.count) claimed.push(candidate);
      }
      return claimed;
    });

    for (const candidate of claimedCandidates) {
      try {
        const result = await sendEmail(preference.emailAddress!, candidate.id, candidate.rerankScore, preference.unsubscribeToken, now);
        if (!result) { failed++; continue; }
        await prisma.$transaction([
          prisma.emailSendLog.create({ data: { userId: preference.userId, gameMomentId: candidate.id } }),
          prisma.gameMoment.updateMany({ where: { id: candidate.id, userId: preference.userId, status: "queued" }, data: { status: "emailed", sendClaimedAt: null } }),
        ]);
        sent++;
      } catch (error) {
        failed++;
        console.error("Player-style email send failed; candidate remains queued", { momentId: candidate.id, error });
      }
    }
  }
  return { expired: expired.count, sent, failed };
}

async function sendMatchEmail(email: string, momentId: string, score: number, unsubscribeToken: string, now: Date): Promise<boolean> {
  const apiKey = process.env.RESEND_API_KEY;
  const from = process.env.PLAYER_MATCH_FROM_EMAIL;
  const appUrl = process.env.APP_URL;
  if (!apiKey || !from || !appUrl) throw new Error("Set RESEND_API_KEY, PLAYER_MATCH_FROM_EMAIL, and APP_URL to enable player-match email.");
  const origin = new URL(appUrl);
  if (origin.protocol !== "https:" && origin.hostname !== "localhost") throw new Error("APP_URL must use HTTPS outside localhost.");
  const token = createMomentLinkToken(now);
  const persisted = await prisma.gameMoment.updateMany({
    where: { id: momentId, status: "queued" },
    data: { deepLinkTokenHash: token.tokenHash, deepLinkExpiresAt: token.expiresAt },
  });
  if (!persisted.count) throw new Error("The queued match is no longer available for email delivery.");
  const deepLink = new URL(`/moments/${encodeURIComponent(token.token)}`, origin).toString();
  const unsubscribeLink = new URL(`/unsubscribe/${encodeURIComponent(unsubscribeToken)}`, origin).toString();
  const moment = await prisma.gameMoment.findUnique({ where: { id: momentId }, include: { matchedBigshot: { select: { name: true } } } });
  if (!moment?.matchedBigshot) throw new Error("The match profile no longer exists.");
  const bigshotName = escapeHtml(moment.matchedBigshot.name);
  const message = moment.soundness === "sound"
    ? `You executed a sound ${moment.motifMatch ? "motif" : escapeHtml(moment.phase)} idea, just like ${bigshotName}'s signature style.`
    : `You went for a ${bigshotName}-style idea — the engine wasn't fully convinced, but you pulled it off.`;
  const response = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json", "Idempotency-Key": `player-match-${momentId}` },
    body: JSON.stringify({
      from,
      to: [email],
      subject: "A player-style match from one of your games",
      html: `<p>${message}</p><p>Match score: ${Math.round(score * 100) / 100}</p><p><a href="${deepLink}">Compare the positions</a></p><p><a href="${new URL("/dashboard", origin).toString()}">Open your dashboard</a></p><p><a href="${unsubscribeLink}">Unsubscribe from player-match emails</a></p>`,
    }),
  });
  if (!response.ok) {
    console.error("Player-match email provider rejected a message", { status: response.status, momentId });
    return false;
  }
  return true;
}
