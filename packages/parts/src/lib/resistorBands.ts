/** IEC 60062 colour code. */
export const BAND_COLORS = [
  "#1A1A1A", // 0 black
  "#7A4A26", // 1 brown
  "#E0321E", // 2 red
  "#F28A1E", // 3 orange
  "#F5D020", // 4 yellow
  "#2FA84F", // 5 green
  "#2F6FE0", // 6 blue
  "#8A4FD8", // 7 violet
  "#8C8C8C", // 8 grey
  "#F2F2F2", // 9 white
] as const;
export const GOLD = "#C9A43A";
export const SILVER = "#B8BEC6";

/** 4-band code (2 significant digits + multiplier) for a resistance in ohms. */
export function resistorBands(ohms: number): [string, string, string] {
  if (!(ohms > 0) || !Number.isFinite(ohms)) return [BAND_COLORS[0], BAND_COLORS[0], BAND_COLORS[0]];
  let exp = Math.floor(Math.log10(ohms)) - 1;
  let digits = Math.round(ohms / 10 ** exp);
  if (digits >= 100) {
    digits = Math.round(digits / 10);
    exp += 1;
  }
  exp = Math.max(-2, Math.min(9, exp));
  const d1 = Math.floor(digits / 10) % 10;
  const d2 = digits % 10;
  const mult = exp === -1 ? GOLD : exp === -2 ? SILVER : BAND_COLORS[exp]!;
  return [BAND_COLORS[d1]!, BAND_COLORS[d2]!, mult];
}

/** "220 Ω", "4.7 kΩ", "1 MΩ". */
export function formatOhms(ohms: number): string {
  const fmt = (v: number) => String(Number(v.toPrecision(3)));
  if (ohms >= 1e6) return `${fmt(ohms / 1e6)} MΩ`;
  if (ohms >= 1e3) return `${fmt(ohms / 1e3)} kΩ`;
  return `${fmt(ohms)} Ω`;
}
