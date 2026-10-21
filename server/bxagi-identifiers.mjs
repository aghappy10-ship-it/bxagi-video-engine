// BXAGI serializes UUIDs in both compact and hyphenated form. Normalize only
// complete UUIDs for equality checks; preserve every other identifier exactly.
export function bxagiIdentifierKey(value) {
  if (typeof value !== 'string') return value;
  return /^(?:[a-f\d]{32}|[a-f\d]{8}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{12})$/i.test(value)
    ? value.replaceAll('-', '').toLowerCase() : value;
}
export const sameBxagiIdentifier = (a, b) => typeof a === 'string' && typeof b === 'string' && bxagiIdentifierKey(a) === bxagiIdentifierKey(b);
