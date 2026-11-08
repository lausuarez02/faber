/**
 * Minimal Intel HEX parser (record types 00 data, 01 EOF, 02 extended segment address,
 * 04 extended linear address; 03/05 start addresses are accepted and ignored).
 * Returns a flat image from address 0 up to the highest written byte; gaps are 0xFF (erased flash).
 */
export function parseIntelHex(text: string): Uint8Array {
  const chunks: { addr: number; bytes: number[] }[] = [];
  let base = 0;
  let max = 0;
  const lines = text.split(/\r?\n/);
  for (let ln = 0; ln < lines.length; ln++) {
    const line = lines[ln]!.trim();
    if (!line) continue;
    if (line[0] !== ":") throw new Error(`hex line ${ln + 1}: must start with ':'`);
    const raw: number[] = [];
    for (let i = 1; i < line.length; i += 2) {
      const b = parseInt(line.slice(i, i + 2), 16);
      if (Number.isNaN(b)) throw new Error(`hex line ${ln + 1}: bad hex digits`);
      raw.push(b);
    }
    const len = raw[0]!;
    if (raw.length !== len + 5) throw new Error(`hex line ${ln + 1}: length mismatch`);
    const sum = raw.reduce((a, b) => (a + b) & 0xff, 0);
    if (sum !== 0) throw new Error(`hex line ${ln + 1}: bad checksum`);
    const addr = (raw[1]! << 8) | raw[2]!;
    const type = raw[3]!;
    const data = raw.slice(4, 4 + len);
    if (type === 0x00) {
      const abs = base + addr;
      chunks.push({ addr: abs, bytes: data });
      max = Math.max(max, abs + len);
    } else if (type === 0x01) {
      break;
    } else if (type === 0x02) {
      base = ((data[0]! << 8) | data[1]!) << 4;
    } else if (type === 0x04) {
      base = ((data[0]! << 8) | data[1]!) * 0x10000;
    }
  }
  const out = new Uint8Array(max).fill(0xff);
  for (const c of chunks) out.set(c.bytes, c.addr);
  return out;
}
