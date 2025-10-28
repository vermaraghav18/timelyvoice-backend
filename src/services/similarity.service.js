// Similarity guard: 3-gram Jaccard over plain text.
export function jaccard3(textA = "", textB = "") {
  const to3 = (txt) => {
    const toks = txt
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, " ")
      .split(/\s+/)
      .filter(Boolean);
    const grams = new Set();
    for (let i = 0; i < toks.length - 2; i++) {
      grams.add(toks.slice(i, i + 3).join(" "));
    }
    return grams;
  };

  const A = to3(textA);
  const B = to3(textB);
  if (!A.size || !B.size) return 0;

  let inter = 0;
  for (const g of A) if (B.has(g)) inter++;
  return inter / (A.size + B.size - inter);
}

export function isTooSimilar(rewritePlain, sourcePlain, threshold = 0.25) {
  try {
    const score = jaccard3(rewritePlain, sourcePlain);
    return { tooSimilar: score >= threshold, score };
  } catch (e) {
    return { tooSimilar: false, score: 0 };
  }
}
