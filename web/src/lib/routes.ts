/** URL helpers shared by pages and links. */

/** The path of a product class's price history page. */
export function classPath(classKey: string): `/vare/${string}` {
  return `/vare/${encodeURIComponent(classKey)}`;
}

/** Characters `encodeURIComponent` leaves as they are, plus `%` escapes. */
const ENCODED_SEGMENT = /^[A-Za-z0-9\-_.!~*'()%]*$/;

/**
 * The class key from the `[classKey]` route segment.
 *
 * Next.js hands the segment to pages still percent-encoded but to `generateMetadata` already
 * decoded. A decoded class key always contains `|` or `=` (and often Danish letters), which an
 * encoded segment never does, so the segment is decoded only when it looks encoded. Class keys
 * contain a literal `%` (`fedt=8-12%`), so decoding twice would be wrong. Returns null for
 * blank or malformed segments.
 */
export function classKeyFromSegment(segment: string): string | null {
  let key = segment;
  if (ENCODED_SEGMENT.test(segment)) {
    try {
      key = decodeURIComponent(segment);
    } catch {
      return null;
    }
  }
  return key.trim() ? key : null;
}
