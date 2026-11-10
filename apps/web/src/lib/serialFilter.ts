/**
 * Round 6b: the Serial filter. Words separated by spaces; a line shows when it contains every plain
 * word and none of the words written with a leading "-" (case does not matter). "mood" shows only
 * the mood lines; "-look" hides the "look x= y=" lines. The line still being written shows when
 * it matches so far.
 */
export function filterSerial(text: string, query: string): string {
  const words = query.toLowerCase().split(/\s+/).filter((w) => w && w !== "-");
  if (!words.length) return text;
  const want = words.filter((w) => !w.startsWith("-"));
  const hide = words.filter((w) => w.startsWith("-")).map((w) => w.slice(1));
  const lines = text.split("\n");
  const last = lines.pop() ?? "";
  const keep = (l: string) => {
    const low = l.toLowerCase();
    return want.every((w) => low.includes(w)) && !hide.some((w) => low.includes(w));
  };
  const out = lines.filter(keep).map((l) => `${l}\n`).join("");
  return out + (last && keep(last) ? last : "");
}
