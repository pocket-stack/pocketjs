// class-string → styleId map.
//
// The build-time Tailwind-subset compiler (framework/compiler/tailwind.ts) assigns a
// styleId to every class LITERAL it finds in the source AST and emits
// styles.generated.ts, whose table the app registers here (index.ts wires
// this module into the renderer via setStyleResolver — no hard dependency on
// the generated file from library code).
//
// Normalization: trim + collapse internal whitespace. The compiler registers
// the literal VERBATIM (post-normalization) — token order is NOT canonicalized
// away, because 'a b' and 'b a' are the same style only if the compiler said
// so. We do, however, register a token-SORTED alias for each literal so that
// 'a b' resolves the id registered for 'b a' (and vice versa); verbatim
// registrations always win over aliases.

const verbatim = new Map<string, number>();
const sortedAlias = new Map<string, number>();

/** trim + collapse runs of whitespace to single spaces. */
function normalize(cls: string): string {
  return cls.trim().replace(/\s+/g, " ");
}

function sortTokens(normalized: string): string {
  return normalized.split(" ").sort().join(" ");
}

/** sortedAlias value marking an AMBIGUOUS token multiset: two order-sensitive
 *  literals (e.g. "p-2 px-4" vs "px-4 p-2", last-wins) share the multiset but
 *  map to different records — resolving either arbitrarily would be silently
 *  wrong, so the alias is poisoned and only verbatim lookups succeed. */
const ALIAS_AMBIGUOUS = -1;

/** Register a class-literal → styleId table (styles.generated.ts STYLE_IDS). */
export function registerStyles(table: Record<string, number>): void {
  for (const key of Object.keys(table)) {
    const id = table[key];
    const norm = normalize(key);
    verbatim.set(norm, id);
    const sorted = sortTokens(norm);
    const prev = sortedAlias.get(sorted);
    sortedAlias.set(sorted, prev !== undefined && prev !== id ? ALIAS_AMBIGUOUS : id);
  }
}

/** styleId for a class string, or undefined if the compiler never saw it
 *  (or the reordering is ambiguous between order-sensitive literals). */
export function resolveStyle(cls: string): number | undefined {
  const norm = normalize(cls);
  const hit = verbatim.get(norm);
  if (hit !== undefined) return hit;
  const alias = sortedAlias.get(sortTokens(norm));
  return alias === ALIAS_AMBIGUOUS ? undefined : alias;
}

/** Number of registered class literals (diagnostics/tests). */
export function styleCount(): number {
  return verbatim.size;
}

/** Drop every registration (tests). */
export function resetStyles(): void {
  verbatim.clear();
  sortedAlias.clear();
}
