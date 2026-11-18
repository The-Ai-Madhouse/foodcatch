/** URL helpers shared by pages and links. */

/** The path of a product class's price history page. */
export function classPath(classKey: string): `/vare/${string}` {
  return `/vare/${encodeURIComponent(classKey)}`;
}

/**
 * The class key from the `[classKey]` route segment.
 *
 * Next.js passes dynamic segments still percent-encoded; class keys contain `%`, `|`, `=` and
 * Danish letters, so the segment is decoded exactly once. Malformed encodings yield null.
 */
export function classKeyFromSegment(segment: string): string | null {
  try {
    const key = decodeURIComponent(segment);
    return key.trim() ? key : null;
  } catch {
    return null;
  }
}
