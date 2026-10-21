/**
 * Parse bounded upstream JSON without rounding integer identifiers.
 * Unsafe integer tokens become BigInt; strings and safe numbers keep their types.
 * This does not depend on the optional JSON.parse reviver context.source API.
 */
export function parseChangduJson(text) {
  let position = 0;
  const invalid = () => { throw new SyntaxError('Invalid upstream JSON'); };
  const whitespace = () => { while (/[ \t\r\n]/.test(text[position] || '\0')) position++; };
  function string() {
    const start = position++;
    while (position < text.length) {
      const character = text[position++];
      if (character === '"') return JSON.parse(text.slice(start, position));
      if (character === '\\') position++;
    }
    invalid();
  }
  function value(depth) {
    if (depth > 64) invalid();
    whitespace();
    const first = text[position];
    if (first === '"') return string();
    if (first === '[' || first === '{') {
      const array = first === '[';
      const result = array ? [] : Object.create(null);
      const end = array ? ']' : '}';
      position++; whitespace();
      if (text[position] === end) { position++; return result; }
      while (position < text.length) {
        if (array) result.push(value(depth + 1));
        else {
          if (text[position] !== '"') invalid();
          const key = string();
          if (Object.hasOwn(result, key)) invalid();
          whitespace();
          if (text[position++] !== ':') invalid();
          result[key] = value(depth + 1);
        }
        whitespace();
        const delimiter = text[position++];
        if (delimiter === end) return result;
        if (delimiter !== ',') invalid();
        whitespace();
      }
      invalid();
    }
    for (const [literal, parsed] of [['true', true], ['false', false], ['null', null]]) {
      if (text.startsWith(literal, position)) { position += literal.length; return parsed; }
    }
    const token = /^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?/.exec(text.slice(position))?.[0];
    if (!token || token.length > 128) invalid();
    position += token.length;
    const number = Number(token);
    if (/^-?[0-9]+$/.test(token) && !Number.isSafeInteger(number)) return BigInt(token);
    if (!Number.isFinite(number)) invalid();
    return number;
  }
  const result = value(0);
  whitespace();
  if (position !== text.length) invalid();
  return result;
}
