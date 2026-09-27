const escapeRe = (s: string) => s.replace(/[.+^${}()|[\]\\]/g, '\\$&');

/** Case-insensitive glob over a whole string: `*` = any run of characters, `?` = one character. */
export function globMatch(pattern: string, value: string): boolean {
  const source = pattern
    .split('*')
    .map((part) => part.split('?').map(escapeRe).join('.'))
    .join('.*');
  return new RegExp(`^${source}$`, 'i').test(value);
}
