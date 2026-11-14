// Calendar arithmetic for real-time-clock part models (no Date in models: determinism). Shared by
// the DS3231 and RV-3028 models.

/** Days since 1970-01-01 for a proleptic Gregorian date (H. Hinnant's algorithm). */
export function daysFromCivil(y: number, m: number, d: number): number {
  const yy = m <= 2 ? y - 1 : y;
  const era = Math.floor(yy / 400);
  const yoe = yy - era * 400;
  const doy = Math.floor((153 * (m + (m > 2 ? -3 : 9)) + 2) / 5) + d - 1;
  const doe = yoe * 365 + Math.floor(yoe / 4) - Math.floor(yoe / 100) + doy;
  return era * 146097 + doe - 719468;
}

export function civilFromDays(z0: number): { y: number; m: number; d: number } {
  const z = z0 + 719468;
  const era = Math.floor(z / 146097);
  const doe = z - era * 146097;
  const yoe = Math.floor((doe - Math.floor(doe / 1460) + Math.floor(doe / 36524) - Math.floor(doe / 146096)) / 365);
  const doy = doe - (365 * yoe + Math.floor(yoe / 4) - Math.floor(yoe / 100));
  const mp = Math.floor((5 * doy + 2) / 153);
  const d = doy - Math.floor((153 * mp + 2) / 5) + 1;
  const m = mp + (mp < 10 ? 3 : -9);
  return { y: yoe + era * 400 + (m <= 2 ? 1 : 0), m, d };
}

export interface DateTime {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
}

/** Seconds since 1970-01-01 00:00:00 (no time zone). */
export function toEpoch(t: DateTime): number {
  return daysFromCivil(t.year, t.month, t.day) * 86400 + t.hour * 3600 + t.minute * 60 + t.second;
}

export function fromEpoch(s: number): DateTime & { weekday: number } {
  const days = Math.floor(s / 86400);
  const rest = s - days * 86400;
  const { y, m, d } = civilFromDays(days);
  // 1970-01-01 was a Thursday. weekday: 0 = Sunday … 6 = Saturday.
  const weekday = (((days + 4) % 7) + 7) % 7;
  return { year: y, month: m, day: d, hour: Math.floor(rest / 3600), minute: Math.floor((rest % 3600) / 60), second: rest % 60, weekday };
}

/** Parse "YYYY-MM-DDTHH:MM:SS" (or a space instead of T). Returns undefined when malformed. */
export function parseTime(v: string): number | undefined {
  const m = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2}))?$/.exec(v.trim());
  if (!m) return undefined;
  const [, y, mo, d, h, mi, s] = m.map(Number) as number[];
  if (mo! < 1 || mo! > 12 || d! < 1 || d! > 31 || h! > 23 || mi! > 59 || (s ?? 0) > 59) return undefined;
  return toEpoch({ year: y!, month: mo!, day: d!, hour: h!, minute: mi!, second: s ?? 0 });
}

export function formatTime(s: number): string {
  const t = fromEpoch(s);
  const p = (n: number, w = 2) => String(n).padStart(w, "0");
  return `${p(t.year, 4)}-${p(t.month)}-${p(t.day)} ${p(t.hour)}:${p(t.minute)}:${p(t.second)}`;
}

export const bcd = (n: number): number => ((Math.floor(n / 10) % 10) << 4) | n % 10;
export const unbcd = (b: number): number => ((b >> 4) & 0x0f) * 10 + (b & 0x0f);
