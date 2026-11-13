// Post-event reflection: one call to the cheapest configured model per merge or stall. The reply is
// either the literal NO_ENTRY or one { cue, lesson, evidence, confidence, class? } entry, which is
// written straight into layer 2 (per-role repo knowledge). Pure: provider and store are injected.

export const REFLECTION_FIELDS = Object.freeze(['cue', 'lesson', 'evidence', 'confidence']);
const nonEmpty = (text) => typeof text === 'string' && text.trim() !== '';

/** @returns {'NO_ENTRY' | { cue, lesson, evidence, confidence, class }} */
export function parseReflection(value) {
  if (value === 'NO_ENTRY') return 'NO_ENTRY';
  const valid = value && typeof value === 'object' && nonEmpty(value.cue) && nonEmpty(value.lesson)
    && typeof value.evidence === 'string' && typeof value.confidence === 'number'
    && value.confidence >= 0 && value.confidence <= 1;
  if (!valid) throw new TypeError('invalid reflection');
  if (value.evidence.trim() === '') return 'NO_ENTRY';
  return { cue: value.cue, lesson: value.lesson, evidence: value.evidence, confidence: value.confidence, class: value.class ?? 'unknown' };
}

/** Exactly one provider call; NO_ENTRY writes nothing. */
export async function reflect({ event, provider, store, role = 'chief' }) {
  const entry = parseReflection(await provider.call(event));
  if (entry === 'NO_ENTRY') return { status: 'NO_ENTRY' };
  const id = event.id ?? String(event.at);
  store.save({ layer: 2, role, id, ...entry });
  return { status: 'saved', entry };
}

/** A cited entry whose failure class recurs is demoted (removed); one not followed by it is kept. */
export function resolveReflection({ store, id, cited, laterClass }) {
  if (!cited) return { status: 'unkept' };
  if (laterClass === store.get(id).class) {
    store.remove(id);
    return { status: 'demoted' };
  }
  store.update(id, { status: 'kept' });
  return { status: 'kept' };
}
