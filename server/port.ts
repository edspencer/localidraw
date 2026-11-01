// The default port. 3729 spells "DRAW" on a phone keypad. (The first four letters of the name, LOCA, would be
// 5622, which is Local Review's port.)
export const DEFAULT_PORT = 3729;

/** A port number from a flag or $PORT, or null if it isn't one. */
export function parsePort(value: string): number | null {
  if (!/^\d+$/.test(value)) return null;
  const n = Number(value);
  return n >= 0 && n <= 65535 ? n : null;
}
