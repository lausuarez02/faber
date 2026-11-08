/** Arduino board pin names → ATmega328P port bits and ADC channels. */
export type BoardType = "uno" | "nano";

export interface BoardPin {
  /** Board pin id, e.g. "D13", "A0". Same names as the board part's pin ids. */
  id: string;
  /** GPIO port (undefined for analog-only pins such as the Nano's A6/A7). */
  port?: "B" | "C" | "D";
  bit?: number;
  /** ADC channel (ADC0..ADC7) for analog-capable pins. */
  adc?: number;
}

/** Uno and Nano share the ATmega328P map: D0–D7 = PD0–7, D8–D13 = PB0–5, A0–A5 = PC0–5 (ADC0–5). The Nano adds A6/A7 (ADC6/7, analog only). */
export function boardPinMap(board: BoardType): readonly BoardPin[] {
  const pins: BoardPin[] = [];
  for (let i = 0; i <= 7; i++) pins.push({ id: `D${i}`, port: "D", bit: i });
  for (let i = 8; i <= 13; i++) pins.push({ id: `D${i}`, port: "B", bit: i - 8 });
  for (let i = 0; i <= 5; i++) pins.push({ id: `A${i}`, port: "C", bit: i, adc: i });
  if (board === "nano") {
    pins.push({ id: "A6", adc: 6 }, { id: "A7", adc: 7 });
  }
  return pins;
}

/** Maps a board part type id (e.g. "arduino-uno") to its pin naming. */
export function boardTypeOf(partType: string): BoardType | undefined {
  const t = partType.toLowerCase();
  if (t === "uno" || t === "arduino-uno") return "uno";
  if (t === "nano" || t === "arduino-nano") return "nano";
  return undefined;
}
