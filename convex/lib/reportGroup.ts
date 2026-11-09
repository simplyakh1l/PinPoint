import type { Doc } from "../_generated/dataModel";
import { incidentMeaning } from "./dedup";
import type { QueryCtx } from "../_generated/server";

/** The first linked report owns moderation for the whole incident. */
export async function reportGroup(ctx: Pick<QueryCtx, "db">, report: Doc<"reports">) {
  const link = await ctx.db.query("incidentReports").withIndex("by_report", q => q.eq("reportId", report._id)).first();
  const first = link ? await ctx.db.query("incidentReports").withIndex("by_incident", q => q.eq("incidentId", link.incidentId)).first() : null;
  const linkedOriginal = first ? await ctx.db.get("reports", first.reportId) : null;
  let original = linkedOriginal?.eventId === report.eventId ? linkedOriginal : report;
  let incidentId = link?.incidentId ?? null;
  const incidentIds = new Set(incidentId ? [incidentId] : []);
  const unlinkedReports: Doc<"reports">[] = [];
  // Existing reports created before the matcher fix may already have separate
  // incident IDs. Reconcile their cards using only a recognized short phrase,
  // a tight time window, and nearby pins; retain all evidence documents.
  const meaning = incidentMeaning(original.description);
  const ownIncident = link ? await ctx.db.get("incidents", link.incidentId) : null;
  if (meaning === "fire outbreak" && !original.resolved && !ownIncident?.isResolved) {
    const anchor = original;
    const candidates = await ctx.db.query("reports").withIndex("by_event_created", q =>
      q.eq("eventId", report.eventId).gte("createdAt", anchor.createdAt - 60_000)
        .lte("createdAt", anchor.createdAt + 60_000)).order("asc").take(200);
    for (const candidate of candidates) {
      if (incidentMeaning(candidate.description) !== meaning || candidate.resolved
        || Math.hypot(candidate.pinX - anchor.pinX, candidate.pinY - anchor.pinY) > 10) continue;
      const candidateLink = await ctx.db.query("incidentReports").withIndex("by_report", q => q.eq("reportId", candidate._id)).first();
      const incident = candidateLink ? await ctx.db.get("incidents", candidateLink.incidentId) : null;
      if (incident?.isResolved) continue;
      if (candidateLink) incidentIds.add(candidateLink.incidentId);
      else unlinkedReports.push(candidate);
      if (candidate.createdAt < original.createdAt || (candidate.createdAt === original.createdAt && candidate._creationTime < original._creationTime)) {
        original = candidate;
        incidentId = candidateLink?.incidentId ?? null;
      }
    }
  }
  return { original, incidentId, incidentIds: [...incidentIds], unlinkedReports };

}

export function sourcePriority(count: number): "high" | "critical" | null {
  return count >= 5 ? "critical" : count >= 3 ? "high" : null;
}
