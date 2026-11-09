export function tokenize(text: string): Set<string> {
  return new Set(text.normalize("NFKC").toLowerCase().replace(/[^\p{L}\p{N}\p{M}\s]/gu, " ").split(/\s+/).filter(w => w.length > 1));
}
export function jaccardSimilarity(a: Set<string>, b: Set<string>) {
  if (!a.size || !b.size) return 0;
  const overlap = [...a].filter(x => b.has(x)).length;
  return overlap / (a.size + b.size - overlap);
}

export const DEDUP_WINDOW_MS = 45 * 60 * 1000;
export const DEDUP_RADIUS = 10;
export function normalizedDescription(text: string) {
  return text.normalize("NFKC").toLowerCase().replace(/[^\p{L}\p{N}\p{M}\s]/gu, " ").replace(/\s+/g, " ").trim();
}

/** Short affirmative reports of an outbreak, across common EN/HI spellings.
 * Anchored phrases preserve negation and qualifiers identifying different fires.
 */
export function incidentMeaning(text: string): string {
  const normalized = normalizedDescription(text).replace(/^fire+$/, "fire");
  if (/^(?:(?:there is |there s |a )?fire(?: (?:breakout|break out|broke out|outbreak))?|(?:fire|aag|ag) (?:lag|lg|lagi) (?:gyi|gayi|gai|gya|gaya)(?: (?:hai|h|he))?|(?:fire|aag|ag) lagi(?: (?:hai|h|he))?|आग लगी है)$/.test(normalized)) return "fire outbreak";
  return normalized;
}

/** Exact repeats also match unclassified reports; proximity alone never merges. */
export function duplicateScore(a: { incidentType: string; description: string; pinX: number; pinY: number }, b: typeof a) {
  const distance = Math.hypot(a.pinX - b.pinX, a.pinY - b.pinY);
  if (distance > DEDUP_RADIUS) return 0;
  if (a.incidentType !== b.incidentType && a.incidentType !== "other" && b.incidentType !== "other") return 0;
  const text = incidentMeaning(a.description);
  if (text && text === incidentMeaning(b.description)) return 1;
  if (a.incidentType === "other" || a.incidentType !== b.incidentType) return 0;
  const similarity = jaccardSimilarity(tokenize(a.description), tokenize(b.description));
  return similarity >= 0.55 ? Math.min(1, similarity + 0.1 * (1 - distance / 10)) : 0;
}
