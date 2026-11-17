// Fabwright was called Jumper until November 2026, and kept its per-browser settings (theme, mute,
// autorun, kit ticks…) under "jumper." / "jumper:" keys. Copy each to its new key once, before the app
// reads them, so the rename does not reset anyone's settings. Imported first by main.tsx.

const PREFIXES: ReadonlyArray<readonly [string, string]> = [
  ["jumper.", "fabwright."],
  ["jumper:", "fabwright:"],
];

/** Copies every pre-rename key whose new key is not set yet. Returns the new keys it wrote. */
export function migrateLegacyStorage(storage: Pick<Storage, "length" | "key" | "getItem" | "setItem">): string[] {
  const written: string[] = [];
  const keys: string[] = [];
  for (let i = 0; i < storage.length; i++) {
    const k = storage.key(i);
    if (k !== null) keys.push(k);
  }
  for (const key of keys) {
    for (const [old, now] of PREFIXES) {
      if (!key.startsWith(old)) continue;
      const next = now + key.slice(old.length);
      const value = storage.getItem(key);
      if (value !== null && storage.getItem(next) === null) {
        storage.setItem(next, value);
        written.push(next);
      }
    }
  }
  return written;
}

try {
  if (typeof localStorage !== "undefined") migrateLegacyStorage(localStorage);
} catch {
  // storage blocked (private mode, file://): settings simply start fresh
}
