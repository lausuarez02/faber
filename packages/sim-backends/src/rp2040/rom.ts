// Faber's own RP2040 boot ROM: the public ROM interface (lookup tables, the float/double
// function tables, memory, bit, flash helpers) laid out where the pico-sdk expects it, with every
// function implemented natively in TypeScript ("high-level emulation").
//
// Why not the real ROM: the Raspberry Pi bootrom binary includes Mark Owen's float library, which
// is licensed only for use on an RP2040 chip (or under GPL-2.0), so it cannot ship in this
// Apache-2.0 project. Nothing here is derived from that code; the layout and calling conventions
// come from the RP2040 datasheet (section 2.8, "Bootrom") and the pico-sdk headers (BSD-3-Clause).
//
// How a call works: each ROM function is a 4-byte Thumb stub `BKPT #id; BX LR`. rp2040js reports
// the BKPT through onBreak(id); we read the arguments from r0-r3, compute, write the results, add
// the cycles the real routine takes (approximate, so time stays plausible) and the BX LR returns.
//
// Fidelity (also in each board's fidelity.json): IEEE-754 single/double arithmetic is exact
// (+, -, *, /, sqrt round correctly, as in the ROM); denormals are flushed to zero like the ROM;
// sin/cos/tan/exp/ln/atan2 use the JavaScript engine's double functions and may differ from the
// ROM in the last bit; cycle costs are typical values, not cycle-exact.
import type { RP2040 } from "rp2040js";

export const ROM_BYTES = 16 * 1024;
/** Version byte at 0x13: 3 = B2 silicon. The SDK skips its workarounds for older ROMs. */
export const ROM_VERSION = 3;

const STUBS = 0x100;
const SF_TABLE = 0x800;
const SD_TABLE = 0x900;
const FUNC_TABLE = 0xa00;
const DATA_TABLE = 0xb00;
const COPYRIGHT_AT = 0xc00;
const GIT_REV_AT = 0xd00;
/** Initial stack pointer in the ROM vector table (top of SRAM5 scratch, as on the chip). */
const INITIAL_SP = 0x2004_2000;
/** boot2 at the start of flash: the reset vector runs it directly (it then jumps to the vector table at 0x10000100). */
const FLASH_ENTRY = 0x1000_0000;

const code = (a: string, b: string) => a.charCodeAt(0) | (b.charCodeAt(0) << 8);

export interface RomCall {
  /** Register r0..r15 (unsigned). */
  r(i: number): number;
  set(i: number, v: number): void;
  read8(addr: number): number;
  write8(addr: number, v: number): void;
  read16(addr: number): number;
  setFlags(n: boolean, z: boolean, c: boolean, v: boolean): void;
  flash: Uint8Array;
  /** Current clk_sys in Hz (for routines whose duration is fixed in time, like flash erase). */
  clkSys(): number;
}

interface RomFn {
  name: string;
  /** Cycles the real ROM routine takes, roughly (added to the clock). May depend on the call. */
  cycles: number | ((c: RomCall) => number);
  run(c: RomCall): void;
  /** Lookup code for the function table ('MC' …). */
  func?: string;
  /** Offset in the single (sf) / double (sd) table. */
  sf?: number;
  sd?: number;
}

// ------------------------------------------------------------------------------- float helpers

const scratch = new DataView(new ArrayBuffer(8));
const F32_MIN_NORMAL = 2 ** -126;
const F64_MIN_NORMAL = 2 ** -1022;

/** float bits → number, denormal inputs read as signed zero (ROM behaviour). */
function f(u: number): number {
  if (((u >>> 23) & 0xff) === 0) return u & 0x8000_0000 ? -0 : 0;
  scratch.setUint32(0, u >>> 0, true);
  return scratch.getFloat32(0, true);
}
/** number → float bits, rounded to nearest even, denormal results flushed to signed zero. */
function fb(x: number): number {
  let y = Math.fround(x);
  if (y !== 0 && Math.abs(y) < F32_MIN_NORMAL) y = y < 0 ? -0 : 0;
  scratch.setFloat32(0, y, true);
  return scratch.getUint32(0, true);
}
function d(lo: number, hi: number): number {
  if (((hi >>> 20) & 0x7ff) === 0) return hi & 0x8000_0000 ? -0 : 0;
  scratch.setUint32(0, lo >>> 0, true);
  scratch.setUint32(4, hi >>> 0, true);
  return scratch.getFloat64(0, true);
}
function db(x: number): [number, number] {
  let y = x;
  if (y !== 0 && Math.abs(y) < F64_MIN_NORMAL) y = y < 0 ? -0 : 0;
  scratch.setFloat64(0, y, true);
  return [scratch.getUint32(0, true), scratch.getUint32(4, true)];
}

const signed = (u: number) => u | 0;
const pow2 = (n: number) => 2 ** n;

/** Round toward −∞ and clamp, as the ROM's float2int / float2fix family does. NaN → 0. */
function floorClampI32(x: number): number {
  if (Number.isNaN(x)) return 0;
  const v = Math.floor(x);
  return v >= 2 ** 31 ? 0x7fff_ffff : v < -(2 ** 31) ? 0x8000_0000 : v >>> 0;
}
function floorClampU32(x: number): number {
  if (Number.isNaN(x) || x <= 0) return 0;
  const v = Math.floor(x);
  return v >= 2 ** 32 ? 0xffff_ffff : v >>> 0;
}
function floorClampI64(x: number): bigint {
  if (Number.isNaN(x)) return 0n;
  if (x >= 2 ** 63) return (1n << 63n) - 1n;
  if (x < -(2 ** 63)) return -(1n << 63n);
  return BigInt(Math.floor(x));
}
function floorClampU64(x: number): bigint {
  if (Number.isNaN(x) || x <= 0) return 0n;
  if (x >= 2 ** 64) return (1n << 64n) - 1n;
  return BigInt(Math.floor(x));
}
function i64(lo: number, hi: number): bigint {
  return BigInt.asIntN(64, (BigInt(hi >>> 0) << 32n) | BigInt(lo >>> 0));
}
function u64(lo: number, hi: number): bigint {
  return (BigInt(hi >>> 0) << 32n) | BigInt(lo >>> 0);
}
function split64(v: bigint): [number, number] {
  const u = BigInt.asUintN(64, v);
  return [Number(u & 0xffff_ffffn), Number(u >> 32n)];
}
/** A 64-bit integer as a correctly rounded float (no double rounding through a 53-bit double). */
function bigToFloat(v: bigint): number {
  const neg = v < 0n;
  let a = neg ? -v : v;
  const bits = a.toString(2).length;
  if (bits > 53) {
    const shift = BigInt(bits - 26);
    const sticky = (a & ((1n << shift) - 1n)) !== 0n ? 1n : 0n;
    a = ((a >> shift) | sticky) << shift;
  }
  const x = Number(a);
  return neg ? -x : x;
}

// ------------------------------------------------------------------------------- the table

const F1 = (name: string, sf: number, cycles: number, op: (a: number) => number): RomFn => ({ name, sf, cycles, run: (c) => c.set(0, fb(op(f(c.r(0))))) });
const F2 = (name: string, sf: number, cycles: number, op: (a: number, b: number) => number): RomFn => ({ name, sf, cycles, run: (c) => c.set(0, fb(op(f(c.r(0)), f(c.r(1))))) });
const D1 = (name: string, sd: number, cycles: number, op: (a: number) => number): RomFn => ({
  name,
  sd,
  cycles,
  run: (c) => {
    const [lo, hi] = db(op(d(c.r(0), c.r(1))));
    c.set(0, lo);
    c.set(1, hi);
  },
});
const D2 = (name: string, sd: number, cycles: number, op: (a: number, b: number) => number): RomFn => ({
  name,
  sd,
  cycles,
  run: (c) => {
    const [lo, hi] = db(op(d(c.r(0), c.r(1)), d(c.r(2), c.r(3))));
    c.set(0, lo);
    c.set(1, hi);
  },
});
const cmp3 = (a: number, b: number) => (a < b ? -1 : a > b ? 1 : a === b ? 0 : 1);
const set64 = (c: RomCall, v: bigint) => {
  const [lo, hi] = split64(v);
  c.set(0, lo);
  c.set(1, hi);
};
const setD = (c: RomCall, x: number) => {
  const [lo, hi] = db(x);
  c.set(0, lo);
  c.set(1, hi);
};
const cmpFlags = (c: RomCall, a: number, b: number) => {
  // As `cmp` would leave them for an ordered compare; unordered (NaN) reads as "greater".
  const lt = a < b;
  const eq = a === b;
  c.setFlags(lt, eq, !lt, false);
};

/** Erase / program time of a typical 2 MB QSPI flash (W25Q16JV): 4 KB sector ~45 ms, 256 B page ~0.7 ms. */
const SECTOR_ERASE_S = 45e-3;
const PAGE_PROGRAM_S = 0.7e-3;

const ROM_FUNCTIONS: RomFn[] = [
  // ---- single precision (sf table)
  F2("fadd", 0x00, 60, (a, b) => a + b),
  F2("fsub", 0x04, 62, (a, b) => a - b),
  F2("fmul", 0x08, 58, (a, b) => a * b),
  F2("fdiv", 0x0c, 74, (a, b) => a / b),
  { name: "fcmp", sf: 0x10, cycles: 30, run: (c) => c.set(0, cmp3(f(c.r(0)), f(c.r(1))) >>> 0) },
  { name: "fcmp_flags", sf: 0x14, cycles: 30, run: (c) => cmpFlags(c, f(c.r(0)), f(c.r(1))) },
  F1("fsqrt", 0x18, 66, Math.sqrt),
  { name: "float2int", sf: 0x1c, cycles: 30, run: (c) => c.set(0, floorClampI32(f(c.r(0)))) },
  { name: "float2fix", sf: 0x20, cycles: 32, run: (c) => c.set(0, floorClampI32(f(c.r(0)) * pow2(signed(c.r(1))))) },
  { name: "float2uint", sf: 0x24, cycles: 30, run: (c) => c.set(0, floorClampU32(f(c.r(0)))) },
  { name: "float2ufix", sf: 0x28, cycles: 32, run: (c) => c.set(0, floorClampU32(f(c.r(0)) * pow2(signed(c.r(1))))) },
  { name: "int2float", sf: 0x2c, cycles: 30, run: (c) => c.set(0, fb(signed(c.r(0)))) },
  { name: "fix2float", sf: 0x30, cycles: 32, run: (c) => c.set(0, fb(signed(c.r(0)) / pow2(signed(c.r(1))))) },
  { name: "uint2float", sf: 0x34, cycles: 30, run: (c) => c.set(0, fb(c.r(0))) },
  { name: "ufix2float", sf: 0x38, cycles: 32, run: (c) => c.set(0, fb(c.r(0) / pow2(signed(c.r(1))))) },
  {
    name: "fcos",
    sf: 0x3c,
    cycles: 380,
    run: (c) => {
      const a = f(c.r(0));
      c.set(0, fb(Math.cos(a)));
      c.set(1, fb(Math.sin(a)));
    },
  },
  {
    // The SDK's sincosf calls fsin and takes the cosine from r1, as the ROM leaves it there.
    name: "fsin",
    sf: 0x40,
    cycles: 380,
    run: (c) => {
      const a = f(c.r(0));
      c.set(0, fb(Math.sin(a)));
      c.set(1, fb(Math.cos(a)));
    },
  },
  F1("ftan", 0x44, 430, Math.tan),
  {
    name: "fsincos",
    sf: 0x48,
    cycles: 400,
    run: (c) => {
      const a = f(c.r(0));
      c.set(0, fb(Math.sin(a)));
      c.set(1, fb(Math.cos(a)));
    },
  },
  F1("fexp", 0x4c, 220, Math.exp),
  F1("fln", 0x50, 300, Math.log),
  { name: "fcmp_basic", sf: 0x54, cycles: 30, run: (c) => c.set(0, cmp3(f(c.r(0)), f(c.r(1))) >>> 0) },
  F2("fatan2", 0x58, 420, (y, x) => Math.atan2(y, x)),
  { name: "int642float", sf: 0x5c, cycles: 60, run: (c) => c.set(0, fb(bigToFloat(i64(c.r(0), c.r(1))))) },
  { name: "fix642float", sf: 0x60, cycles: 64, run: (c) => c.set(0, fb(bigToFloat(i64(c.r(0), c.r(1))) / pow2(signed(c.r(2))))) },
  { name: "uint642float", sf: 0x64, cycles: 60, run: (c) => c.set(0, fb(bigToFloat(u64(c.r(0), c.r(1))))) },
  { name: "ufix642float", sf: 0x68, cycles: 64, run: (c) => c.set(0, fb(bigToFloat(u64(c.r(0), c.r(1))) / pow2(signed(c.r(2))))) },
  { name: "float2int64", sf: 0x6c, cycles: 60, run: (c) => set64(c, floorClampI64(f(c.r(0)))) },
  { name: "float2fix64", sf: 0x70, cycles: 64, run: (c) => set64(c, floorClampI64(f(c.r(0)) * pow2(signed(c.r(1))))) },
  { name: "float2uint64", sf: 0x74, cycles: 60, run: (c) => set64(c, floorClampU64(f(c.r(0)))) },
  { name: "float2ufix64", sf: 0x78, cycles: 64, run: (c) => set64(c, floorClampU64(f(c.r(0)) * pow2(signed(c.r(1))))) },
  { name: "float2double", sf: 0x7c, cycles: 24, run: (c) => setD(c, f(c.r(0))) },

  // ---- double precision (sd table, same offsets)
  D2("dadd", 0x00, 100, (a, b) => a + b),
  D2("dsub", 0x04, 104, (a, b) => a - b),
  D2("dmul", 0x08, 160, (a, b) => a * b),
  D2("ddiv", 0x0c, 320, (a, b) => a / b),
  { name: "dcmp", sd: 0x10, cycles: 40, run: (c) => c.set(0, cmp3(d(c.r(0), c.r(1)), d(c.r(2), c.r(3))) >>> 0) },
  { name: "dcmp_flags", sd: 0x14, cycles: 40, run: (c) => cmpFlags(c, d(c.r(0), c.r(1)), d(c.r(2), c.r(3))) },
  D1("dsqrt", 0x18, 270, Math.sqrt),
  { name: "double2int", sd: 0x1c, cycles: 40, run: (c) => c.set(0, floorClampI32(d(c.r(0), c.r(1)))) },
  { name: "double2fix", sd: 0x20, cycles: 44, run: (c) => c.set(0, floorClampI32(d(c.r(0), c.r(1)) * pow2(signed(c.r(2))))) },
  { name: "double2uint", sd: 0x24, cycles: 40, run: (c) => c.set(0, floorClampU32(d(c.r(0), c.r(1)))) },
  { name: "double2ufix", sd: 0x28, cycles: 44, run: (c) => c.set(0, floorClampU32(d(c.r(0), c.r(1)) * pow2(signed(c.r(2))))) },
  { name: "int2double", sd: 0x2c, cycles: 36, run: (c) => setD(c, signed(c.r(0))) },
  { name: "fix2double", sd: 0x30, cycles: 40, run: (c) => setD(c, signed(c.r(0)) / pow2(signed(c.r(1)))) },
  { name: "uint2double", sd: 0x34, cycles: 36, run: (c) => setD(c, c.r(0)) },
  { name: "ufix2double", sd: 0x38, cycles: 40, run: (c) => setD(c, c.r(0) / pow2(signed(c.r(1)))) },
  D1("dcos", 0x3c, 1700, Math.cos),
  D1("dsin", 0x40, 1700, Math.sin),
  D1("dtan", 0x44, 1900, Math.tan),
  {
    name: "dsincos",
    sd: 0x48,
    cycles: 1900,
    run: (c) => {
      const a = d(c.r(0), c.r(1));
      const [slo, shi] = db(Math.sin(a));
      const [clo, chi] = db(Math.cos(a));
      c.set(0, slo);
      c.set(1, shi);
      c.set(2, clo);
      c.set(3, chi);
    },
  },
  D1("dexp", 0x4c, 1100, Math.exp),
  D1("dln", 0x50, 1500, Math.log),
  { name: "dcmp_basic", sd: 0x54, cycles: 40, run: (c) => c.set(0, cmp3(d(c.r(0), c.r(1)), d(c.r(2), c.r(3))) >>> 0) },
  D2("datan2", 0x58, 1800, (y, x) => Math.atan2(y, x)),
  { name: "int642double", sd: 0x5c, cycles: 70, run: (c) => setD(c, Number(i64(c.r(0), c.r(1)))) },
  { name: "fix642double", sd: 0x60, cycles: 74, run: (c) => setD(c, Number(i64(c.r(0), c.r(1))) / pow2(signed(c.r(2)))) },
  { name: "uint642double", sd: 0x64, cycles: 70, run: (c) => setD(c, Number(u64(c.r(0), c.r(1)))) },
  { name: "ufix642double", sd: 0x68, cycles: 74, run: (c) => setD(c, Number(u64(c.r(0), c.r(1))) / pow2(signed(c.r(2)))) },
  { name: "double2int64", sd: 0x6c, cycles: 70, run: (c) => set64(c, floorClampI64(d(c.r(0), c.r(1)))) },
  { name: "double2fix64", sd: 0x70, cycles: 74, run: (c) => set64(c, floorClampI64(d(c.r(0), c.r(1)) * pow2(signed(c.r(2))))) },
  { name: "double2uint64", sd: 0x74, cycles: 70, run: (c) => set64(c, floorClampU64(d(c.r(0), c.r(1)))) },
  { name: "double2ufix64", sd: 0x78, cycles: 74, run: (c) => set64(c, floorClampU64(d(c.r(0), c.r(1)) * pow2(signed(c.r(2))))) },
  { name: "double2float", sd: 0x7c, cycles: 40, run: (c) => c.set(0, fb(d(c.r(0), c.r(1)))) },

  // ---- function table
  {
    name: "rom_table_lookup",
    cycles: 20,
    run: (c) => {
      let p = c.r(0);
      const want = c.r(1) & 0xffff;
      let found = 0;
      for (let i = 0; i < 256; i++, p += 4) {
        const k = c.read16(p);
        if (k === 0) break;
        if (k === want) {
          found = c.read16(p + 2);
          break;
        }
      }
      c.set(0, found);
    },
  },
  {
    name: "memset",
    func: "MS",
    cycles: (c) => 12 + Math.ceil(c.r(2) / 2),
    run: (c) => {
      const p = c.r(0);
      const v = c.r(1) & 0xff;
      const n = c.r(2);
      for (let i = 0; i < n; i++) c.write8(p + i, v);
    },
  },
  {
    name: "memset4",
    func: "S4",
    cycles: (c) => 10 + Math.ceil(c.r(2) / 4),
    run: (c) => {
      const p = c.r(0);
      const v = c.r(1) & 0xff;
      const n = c.r(2);
      for (let i = 0; i < n; i++) c.write8(p + i, v);
    },
  },
  {
    name: "memcpy",
    func: "MC",
    cycles: (c) => 14 + c.r(2),
    run: (c) => {
      const dst = c.r(0);
      const src = c.r(1);
      const n = c.r(2);
      for (let i = 0; i < n; i++) c.write8(dst + i, c.read8(src + i));
    },
  },
  {
    name: "memcpy44",
    func: "C4",
    cycles: (c) => 12 + Math.ceil(c.r(2) / 2),
    run: (c) => {
      const dst = c.r(0);
      const src = c.r(1);
      const n = c.r(2);
      for (let i = 0; i < n; i++) c.write8(dst + i, c.read8(src + i));
    },
  },
  {
    name: "popcount32",
    func: "P3",
    cycles: 12,
    run: (c) => {
      let v = c.r(0);
      let n = 0;
      while (v) {
        v &= v - 1;
        n++;
      }
      c.set(0, n);
    },
  },
  {
    name: "reverse32",
    func: "R3",
    cycles: 12,
    run: (c) => {
      let v = c.r(0);
      let out = 0;
      for (let i = 0; i < 32; i++) {
        out = (out << 1) | (v & 1);
        v >>>= 1;
      }
      c.set(0, out >>> 0);
    },
  },
  { name: "clz32", func: "L3", cycles: 10, run: (c) => c.set(0, Math.clz32(c.r(0))) },
  {
    name: "ctz32",
    func: "T3",
    cycles: 10,
    run: (c) => {
      const v = c.r(0);
      c.set(0, v === 0 ? 32 : 31 - Math.clz32(v & -v));
    },
  },
  // Flash: XIP reads always work in the emulator, so the mode switches are no-ops; erase and program
  // change the flash image (lost on reset) and take the time a typical flash chip takes.
  { name: "connect_internal_flash", func: "IF", cycles: 100, run: () => {} },
  { name: "flash_exit_xip", func: "EX", cycles: 100, run: () => {} },
  { name: "flash_flush_cache", func: "FC", cycles: 20, run: () => {} },
  { name: "flash_enter_cmd_xip", func: "CX", cycles: 100, run: () => {} },
  {
    name: "flash_range_erase",
    func: "RE",
    cycles: (c) => Math.round(Math.max(1, Math.ceil(c.r(1) / 4096)) * SECTOR_ERASE_S * c.clkSys()),
    run: (c) => {
      const start = c.r(0);
      const end = Math.min(c.flash.length, start + c.r(1));
      if (start < end) c.flash.fill(0xff, start, end);
    },
  },
  {
    name: "flash_range_program",
    func: "RP",
    cycles: (c) => Math.round(Math.max(1, Math.ceil(c.r(2) / 256)) * PAGE_PROGRAM_S * c.clkSys()),
    run: (c) => {
      const start = c.r(0);
      const src = c.r(1);
      const n = c.r(2);
      // NOR flash programming can only clear bits.
      for (let i = 0; i < n && start + i < c.flash.length; i++) c.flash[start + i]! &= c.read8(src + i);
    },
  },
];

/** Things the ROM does that the backend must handle (halts). */
export interface RomHost {
  /** Extra cycles at clk_sys the call took (the backend turns them into time). */
  cost(cycles: number): void;
  /** The CPU stops for good (reset_usb_boot, a firmware BKPT with no debugger, a fault in ROM). */
  halt(reason: string): void;
}

const RESET_USB_BOOT = 0xfd;
const HANG = 0xfe;

/** Build the ROM image (a Uint32Array of 4096 words, as rp2040js expects). */
export function buildRomImage(): Uint32Array {
  const words = new Uint32Array(ROM_BYTES / 4);
  const bytes = new Uint8Array(words.buffer);
  const view = new DataView(words.buffer);
  const stub = (id: number) => STUBS + 4 * id;
  const writeStub = (id: number) => {
    view.setUint16(stub(id), 0xbe00 | id, true); // BKPT #id
    view.setUint16(stub(id) + 2, 0x4770, true); // BX LR
  };
  // Vector table: SP, reset → boot2 at the start of flash, NMI / HardFault → hang stub.
  view.setUint32(0x00, INITIAL_SP, true);
  view.setUint32(0x04, FLASH_ENTRY | 1, true);
  writeStub(HANG);
  view.setUint32(0x08, stub(HANG) | 1, true);
  view.setUint32(0x0c, stub(HANG) | 1, true);
  // Magic 'M' 'u' 0x01, version.
  bytes.set([0x4d, 0x75, 0x01, ROM_VERSION], 0x10);
  view.setUint16(0x14, FUNC_TABLE, true);
  view.setUint16(0x16, DATA_TABLE, true);

  let fp = FUNC_TABLE;
  const funcEntry = (k: number, ptr: number) => {
    view.setUint16(fp, k, true);
    view.setUint16(fp + 2, ptr, true);
    fp += 4;
  };
  ROM_FUNCTIONS.forEach((fn, id) => {
    writeStub(id);
    const ptr = stub(id) | 1;
    if (fn.name === "rom_table_lookup") view.setUint16(0x18, ptr, true);
    if (fn.func) funcEntry(code(fn.func[0]!, fn.func[1]!), ptr);
    if (fn.sf !== undefined) view.setUint32(SF_TABLE + fn.sf, ptr, true);
    if (fn.sd !== undefined) view.setUint32(SD_TABLE + fn.sd, ptr, true);
  });
  writeStub(RESET_USB_BOOT);
  funcEntry(code("U", "B"), stub(RESET_USB_BOOT) | 1);
  view.setUint16(fp, 0, true);
  // The SDK reads the table size (in words) from the byte two before each float table.
  bytes[SF_TABLE - 2] = 0x80 / 4;
  bytes[SD_TABLE - 2] = 0x80 / 4;

  const copyright = "Faber RP2040 ROM (high-level emulation, Apache-2.0)\0";
  for (let i = 0; i < copyright.length; i++) bytes[COPYRIGHT_AT + i] = copyright.charCodeAt(i);
  view.setUint32(GIT_REV_AT, 0x4a554d50, true); // "JUMP"
  let dp = DATA_TABLE;
  for (const [k, ptr] of [
    [code("S", "F"), SF_TABLE],
    [code("S", "D"), SD_TABLE],
    [code("C", "R"), COPYRIGHT_AT],
    [code("G", "R"), GIT_REV_AT],
  ] as const) {
    view.setUint16(dp, k, true);
    view.setUint16(dp + 2, ptr, true);
    dp += 4;
  }
  view.setUint16(dp, 0, true);
  return words;
}

/** Names of the emulated ROM functions (for fidelity notes and tests). */
export const ROM_FUNCTION_NAMES: readonly string[] = ROM_FUNCTIONS.map((fn) => fn.name);

/**
 * Load Faber's ROM into `mcu` and route BKPTs: a BKPT inside the ROM is a function call; one in
 * the firmware stops the CPU, as on a board with no debugger attached (it would lock up).
 */
export function installRom(mcu: RP2040, host: RomHost): void {
  mcu.loadBootrom(buildRomImage());
  const core = mcu.core;
  const call: RomCall = {
    r: (i) => core.registers[i]! >>> 0,
    set: (i, v) => void (core.registers[i] = v >>> 0),
    read8: (a) => mcu.readUint8(a >>> 0),
    write8: (a, v) => mcu.writeUint8(a >>> 0, v & 0xff),
    read16: (a) => mcu.readUint16(a >>> 0),
    setFlags: (n, z, c, v) => {
      core.N = n;
      core.Z = z;
      core.C = c;
      core.V = v;
    },
    flash: mcu.flash,
    clkSys: () => mcu.clkSys,
  };
  mcu.onBreak = (id: number) => {
    const at = (core.PC - 2) >>> 0;
    if (at >= ROM_BYTES) {
      host.halt(`the firmware hit a breakpoint (BKPT #${id}) at 0x${at.toString(16)}. On a board with no debugger attached the CPU locks up here; arduino-pico does this on panic() (e.g. out of memory or a failed assertion)`);
      return;
    }
    if (id === HANG) {
      host.halt("the CPU took a fault before the firmware set up its own vector table");
      return;
    }
    if (id === RESET_USB_BOOT) {
      host.halt("the firmware asked to reboot into the USB bootloader (BOOTSEL), so it stopped running");
      return;
    }
    const fn = ROM_FUNCTIONS[id];
    if (!fn) {
      host.halt(`unknown ROM call #${id}`);
      return;
    }
    const cycles = typeof fn.cycles === "number" ? fn.cycles : fn.cycles(call);
    fn.run(call);
    host.cost(cycles);
  };
}
