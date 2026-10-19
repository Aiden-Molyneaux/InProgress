const WORD = /[A-Z]+(?![a-z])|[A-Z]?[a-z]+|[0-9]+/g;
const VOWEL = /[aeiou]/i;

/** The three-letter code for a project name, before any clash is told apart. */
function baseCode(name: string): string {
  const words = [...name.matchAll(WORD)].slice(0, 3);
  let code = words.map((w) => w[0][0]).join('');
  if (words.length === 0) return 'XXX';
  // Fill from what follows the last initial taken: its consonants first, then its other letters.
  const rest = [...name.slice(words[words.length - 1].index! + 1)].filter((c) => /[A-Za-z0-9]/.test(c));
  const fill = [...rest.filter((c) => !VOWEL.test(c)), ...rest.filter((c) => VOWEL.test(c))];
  code += fill.join('').slice(0, 3 - code.length);
  return code.padEnd(3, 'X').toUpperCase();
}

/**
 * The code block's three letters (spec section 6): each word's first letter, then the name's next consonants, then its
 * other letters. `others` is the names of the projects before this one in the rail: when one shares the code, the third
 * letter becomes the count of those sharing it plus one (`IPR`, then `IP2`, `IP3`).
 */
export function projectCode(name: string, others: readonly string[] = []): string {
  const code = baseCode(name);
  const clashes = others.filter((other) => baseCode(other) === code).length;
  return clashes === 0 ? code : `${code.slice(0, 2)}${clashes + 1}`;
}
