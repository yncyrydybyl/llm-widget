/*
 * Picking what the model reads when everything does not fit: the older room
 * messages most related to a question, or the parts of a long document that
 * answer it. Scores come from sentence embeddings (normalised, so the dot
 * product is the cosine similarity). Pure.
 */
import { splitText } from "./room";

export function dot(a: number[], b: number[]): number {
    let s = 0;
    for (let i = 0; i < a.length; i++) s += a[i] * b[i];
    return s;
}

/** Indices of the `k` best scores at or above `min`, in their original order. */
export function topK(scores: number[], k: number, min = -Infinity): number[] {
    return scores
        .map((s, i) => [s, i] as const)
        .filter(([s]) => s >= min)
        .sort((a, b) => b[0] - a[0])
        .slice(0, k)
        .map(([, i]) => i)
        .sort((a, b) => a - b);
}

/** Paragraph-ish pieces of about `size` characters for retrieval. */
export function chunk(text: string, size = 700): string[] {
    return splitText(text, size).filter((c) => c.trim().length > 0);
}

/**
 * The best-scoring chunks that fit in `budget` characters, in document order,
 * with "[…]" where something was skipped so the model knows it sees excerpts.
 */
export function excerpts(chunks: string[], scores: number[], budget: number): string {
    const order = scores.map((s, i) => [s, i] as const).sort((a, b) => b[0] - a[0]);
    const keep = new Set<number>();
    let used = 0;
    for (const [, i] of order) {
        const len = chunks[i].length + 8;
        if (used + len > budget) continue;
        keep.add(i);
        used += len;
    }
    const out: string[] = [];
    let skipped = false;
    for (let i = 0; i < chunks.length; i++) {
        if (keep.has(i)) {
            if (skipped) out.push("[…]");
            out.push(chunks[i]);
            skipped = false;
        } else skipped = true;
    }
    if (skipped) out.push("[…]");
    return out.join("\n\n");
}
