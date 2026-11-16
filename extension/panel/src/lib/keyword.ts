// Word matching (BM25): scores each text by the words it shares with the question.
// Rare words count more than common ones. Plain code, instant, no model involved.

const STOP = new Set(
  ('a an and are as at be but by can could did do does for from had has have how i if in into is it its me my of on or ' +
    'so than that the their them then there these they this to was we were what when where which who why will with would you your ' +
    'about also any been being here just like more most much not only other our out over some such up very')
    .split(' ')
);

export function tokenize(text: string): string[] {
  const words = text.toLowerCase().match(/[\p{L}\p{N}_]+/gu) ?? [];
  return words.filter((w) => w.length > 1 && !STOP.has(w));
}

/**
 * For each document: the share of the question's word weight it contains, 0 to 1.
 * Rare words weigh more; a question word that appears nowhere in the chat weighs the most.
 * Unlike keywordScores this is absolute, so it can tell "nothing matched" apart from "best match".
 */
export function keywordCoverage(query: string, docs: string[]): number[] {
  const q = [...new Set(tokenize(query))];
  if (!q.length) return docs.map(() => 0);
  const sets = docs.map((d) => new Set(tokenize(d)));
  const idf = q.map((term) => Math.log(1 + (docs.length + 0.5) / (sets.filter((s) => s.has(term)).length + 0.5)));
  const total = idf.reduce((a, b) => a + b, 0);
  return sets.map((s) => q.reduce((sum, term, i) => sum + (s.has(term) ? idf[i] : 0), 0) / total);
}

/** Returns one score per document, scaled so the best match is 1 (all 0 if nothing matches). */
export function keywordScores(query: string, docs: string[]): number[] {
  const q = [...new Set(tokenize(query))];
  const tokens = docs.map(tokenize);
  if (!q.length || !docs.length) return docs.map(() => 0);

  const avgLen = tokens.reduce((n, t) => n + t.length, 0) / docs.length || 1;
  const df = new Map<string, number>();
  for (const term of q) df.set(term, tokens.filter((t) => t.includes(term)).length);

  const k1 = 1.4;
  const b = 0.75;
  const raw = tokens.map((t) => {
    let score = 0;
    for (const term of q) {
      const n = df.get(term) ?? 0;
      if (!n) continue;
      const tf = t.reduce((c, w) => c + (w === term ? 1 : 0), 0);
      if (!tf) continue;
      const idf = Math.log(1 + (docs.length - n + 0.5) / (n + 0.5));
      score += (idf * (tf * (k1 + 1))) / (tf + k1 * (1 - b + (b * t.length) / avgLen));
    }
    return score;
  });
  const max = Math.max(...raw);
  return max > 0 ? raw.map((s) => s / max) : raw;
}
