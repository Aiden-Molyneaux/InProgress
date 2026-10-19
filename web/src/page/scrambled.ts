const CAPITALS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';

/** `name` with its first `settled` letters as they are and the rest random capitals; spaces are kept. */
export function scrambled(name: string, settled: number, random: () => number = Math.random): string {
  return [...name].map((c, i) => (i < settled || c === ' ' ? c : CAPITALS[Math.floor(random() * CAPITALS.length)])).join('');
}
