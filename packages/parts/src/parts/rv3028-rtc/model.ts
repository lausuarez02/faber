// Micro Crystal RV-3028-C7 extreme-low-power real-time clock (Application Manual rev. 1.4, 2021):
// I2C address 0x52; RAM registers 0x00-0x3F with auto-increment and wrap 0x3F -> 0x00; BCD time and
// date 0x00-0x06 (year 00-99 = 2000-2099, 12/24-hour mode from Control 2 bit 1), status 0x0E (PORF
// bit 0, set at power-on, cleared by writing 0), the 32-bit UNIX time counter 0x1B-0x1E (binary,
// LSB first, independent of the calendar), user RAM, the EEPROM interface 0x25-0x27 and the
// configuration EEPROM mirrored in RAM at 0x30-0x37 (0x37: backup switchover BSM, trickle charge
// TCE). Time is deterministic: startTime prop + simulation time (+ whatever the sketch set).
import type { Diagnostic, I2cDevice, PartModel, PartModelFactory } from "@fabwright/sim-core";
import { createI2cModule } from "../../lib/i2cModule.ts";
import { clamp, round, truthy } from "../../lib/props.ts";
import { bcd, formatTime, fromEpoch, parseTime, toEpoch, unbcd } from "../../lib/calendar.ts";

export const RV3028_ADDRESS = 0x52;
const REGS = 0x40;
/** ID register (0x28): HID in bits 7:4, VID in 3:0. Factory value; 0x30 here (not checked by the common libraries). */
const ID = 0x30;
/** EEPROM 0x37 on delivery: FEDE = 1, BSM = 00 (backup switchover disabled), TCE = 0 (datasheet 3.18). */
const BACKUP_DEFAULT = 0x10;
/** EEPROM 0x35 on delivery: CLKOE = 1, CLKSY = 1. */
const CLKOUT_DEFAULT = 0xc0;

export class Rv3028 {
  regs = new Uint8Array(REGS);
  /** User EEPROM 0x00-0x2A and the configuration EEPROM 0x2B-0x37 (index = EEPROM address). */
  eeprom = new Uint8Array(0x38);
  /** Calendar seconds at sim time `phaseMs`. */
  base: number;
  private phaseMs = 0;
  /** UNIX counter value at `unixPhaseMs`. */
  private unixBase = 0;
  private unixPhaseMs = 0;
  /** Weekday the sketch assigned, as an offset from the weekday of the date (the chip counts 0-6 on its own). */
  private weekdayOffset = 0;
  ptr = 0;
  private first = true;
  private latched: Uint8Array | undefined;
  private wroteTime = false;
  private wroteSeconds = false;
  private wroteUnix = false;
  /** EEPROM bytes written with EECMD 0x21 or an update (0x11). */
  eepromWrites = 0;
  /** True once the sketch read or wrote anything. */
  touched = false;

  constructor(
    startEpoch: number,
    lostPower: boolean,
    private readonly nowMs: () => number,
  ) {
    this.base = startEpoch;
    this.unixBase = startEpoch;
    this.regs[0x04] = 1;
    this.regs[0x05] = 1;
    this.regs[0x07] = this.regs[0x08] = this.regs[0x09] = 0x80;
    this.regs[0x0e] = lostPower ? 0x01 : 0x00; // PORF
    this.regs[0x28] = ID;
    this.eeprom[0x35] = CLKOUT_DEFAULT;
    this.eeprom[0x37] = BACKUP_DEFAULT;
    this.regs[0x35] = CLKOUT_DEFAULT;
    this.regs[0x37] = BACKUP_DEFAULT;
  }

  /** Calendar time in whole seconds now. */
  epoch(): number {
    return this.base + Math.floor((this.nowMs() - this.phaseMs) / 1000);
  }

  /** The UNIX time counter now. */
  unix(): number {
    return (this.unixBase + Math.floor((this.nowMs() - this.unixPhaseMs) / 1000)) >>> 0;
  }

  /** Set the calendar (and the UNIX counter with it, as a set-time interaction does) to `s` seconds, restarting the second. */
  setTime(s: number): void {
    this.base = s;
    this.phaseMs = this.nowMs();
    this.unixBase = s;
    this.unixPhaseMs = this.phaseMs;
  }

  get twelveHour(): boolean {
    return (this.regs[0x10]! & 0x02) !== 0;
  }

  /** Backup switchover mode (EEPROM 0x37 bits 3:2): 00 / 10 off (delivery), 01 direct, 11 level. */
  get backupSwitchover(): "off" | "direct" | "level" {
    const bsm = (this.regs[0x37]! >> 2) & 3;
    return bsm === 1 ? "direct" : bsm === 3 ? "level" : "off";
  }

  get trickleCharge(): boolean {
    return (this.regs[0x37]! & 0x20) !== 0;
  }

  snapshot(): Uint8Array {
    const r = this.regs.slice();
    const t = fromEpoch(this.epoch());
    r[0x00] = bcd(t.second);
    r[0x01] = bcd(t.minute);
    if (this.twelveHour) {
      const h12 = t.hour % 12 === 0 ? 12 : t.hour % 12;
      r[0x02] = (t.hour >= 12 ? 0x20 : 0) | bcd(h12);
    } else r[0x02] = bcd(t.hour);
    r[0x03] = (((t.weekday + this.weekdayOffset) % 7) + 7) % 7;
    r[0x04] = bcd(t.day);
    r[0x05] = bcd(t.month);
    r[0x06] = bcd(t.year % 100);
    const u = this.unix();
    r[0x1b] = u & 0xff;
    r[0x1c] = (u >>> 8) & 0xff;
    r[0x1d] = (u >>> 16) & 0xff;
    r[0x1e] = (u >>> 24) & 0xff;
    for (const a of [0x21, 0x22, 0x23, 0x24, 0x31, 0x32, 0x33, 0x34]) r[a] = 0; // write-only
    return r;
  }

  connect(read: boolean): void {
    this.touched = true;
    if (read) this.latched = this.snapshot(); // counters are blocked during the access: coherent reads
    else this.first = true;
  }

  write(b: number): void {
    if (this.first) {
      this.ptr = b & 0x3f;
      this.first = false;
      return;
    }
    const a = this.ptr;
    if (a <= 0x06) {
      if (!this.wroteTime) {
        this.regs.set(this.snapshot().subarray(0, 7));
        this.wroteTime = true;
      }
      if (a === 0x00) this.wroteSeconds = true;
      this.regs[a] = b;
    } else if (a >= 0x1b && a <= 0x1e) {
      if (!this.wroteUnix) {
        this.regs.set(this.snapshot().subarray(0x1b, 0x1f), 0x1b);
        this.wroteUnix = true;
      }
      this.regs[a] = b;
    } else if (a === 0x0e) {
      // flags are cleared by writing 0; EEbusy (bit 7) is read-only
      this.regs[0x0e] = this.regs[0x0e]! & b & 0x7f;
    } else if (a === 0x0c || a === 0x0d || (a >= 0x14 && a <= 0x1a) || a === 0x28 || a === 0x29 || a === 0x2a || (a >= 0x2c && a <= 0x2f) || a >= 0x38) {
      // read-only or reserved
    } else if (a === 0x10) {
      if (b & 0x01) this.phaseMs = this.nowMs(); // RESET bit: restarts the 1 Hz prescaler, reads back 0
      this.regs[0x10] = b & 0xfe;
    } else if (a === 0x27) {
      this.eeCommand(b);
    } else {
      this.regs[a] = b;
    }
    this.ptr = (a + 1) % REGS;
  }

  private eeCommand(cmd: number): void {
    const addr = this.regs[0x25]!;
    if (cmd === 0x11) {
      // update: configuration RAM mirror -> EEPROM
      for (let k = 0x30; k <= 0x37; k++) this.eeprom[k] = this.regs[k]!;
      this.eepromWrites++;
    } else if (cmd === 0x12) {
      for (let k = 0x30; k <= 0x37; k++) this.regs[k] = this.eeprom[k]!;
    } else if (cmd === 0x21 && addr < this.eeprom.length) {
      this.eeprom[addr] = this.regs[0x26]!;
      if (addr >= 0x30) this.regs[addr] = this.regs[0x26]!;
      this.eepromWrites++;
    } else if (cmd === 0x22 && addr < this.eeprom.length) {
      this.regs[0x26] = this.eeprom[addr]!;
    }
  }

  read(): number {
    this.touched = true;
    const src = this.latched ?? this.snapshot();
    const b = src[this.ptr]!;
    this.ptr = (this.ptr + 1) % REGS;
    return b;
  }

  stop(): void {
    this.latched = undefined;
    if (this.wroteTime) this.commitTime();
    if (this.wroteUnix) {
      this.wroteUnix = false;
      const r = this.regs;
      this.unixBase = (r[0x1b]! | (r[0x1c]! << 8) | (r[0x1d]! << 16) | (r[0x1e]! << 24)) >>> 0;
      this.unixPhaseMs = this.nowMs(); // the counter was inhibited while written
    }
  }

  private commitTime(): void {
    this.wroteTime = false;
    const r = this.regs;
    const h = r[0x02]!;
    const hour = this.twelveHour ? (unbcd(h & 0x1f) % 12) + (h & 0x20 ? 12 : 0) : unbcd(h & 0x3f);
    const t = {
      year: 2000 + unbcd(r[0x06]!),
      month: clamp(unbcd(r[0x05]! & 0x1f), 1, 12),
      day: clamp(unbcd(r[0x04]! & 0x3f), 1, 31),
      hour: clamp(hour, 0, 23),
      minute: clamp(unbcd(r[0x01]! & 0x7f), 0, 59),
      second: clamp(unbcd(r[0x00]! & 0x7f), 0, 59),
    };
    const s = toEpoch(t);
    if (this.wroteSeconds) {
      this.phaseMs = this.nowMs(); // writing the seconds resets the prescaler
      this.base = s;
    } else this.base = s - Math.floor((this.nowMs() - this.phaseMs) / 1000);
    this.wroteSeconds = false;
    this.weekdayOffset = (((r[0x03]! & 0x07) - fromEpoch(s).weekday) % 7 + 7) % 7;
  }
}

const DEFAULT_START = "2026-01-01T12:00:00";
/** RV-3028-C7 timekeeping current with I2C idle, 45 nA typical at 3 V (datasheet IDD), in mA. */
const CHIP_MA = 0.000045;

export const create: PartModelFactory = (ctx): PartModel => {
  const mod = createI2cModule(ctx, { supplymA: CHIP_MA, minVolts: 1.2, maxVolts: 5.5 });
  let badStart: string | undefined;
  const startOf = (v: unknown) => {
    const s = typeof v === "string" ? parseTime(v) : undefined;
    badStart = s === undefined ? String(v) : undefined;
    return s ?? parseTime(DEFAULT_START)!;
  };
  const chip = new Rv3028(startOf(ctx.props.startTime), truthy(ctx.props.lostPower), () => ctx.now());

  const i2c: I2cDevice = {
    i2cAddress: () => RV3028_ADDRESS,
    i2cConnect(read) {
      if (!mod.powered) return false;
      chip.connect(read);
      return true;
    },
    i2cWrite(b) {
      chip.write(b);
      return true;
    },
    i2cRead: () => chip.read(),
    i2cStop: () => chip.stop(),
  };

  return {
    i2c,
    stamp: (c) => mod.stamp(c),
    onSolved: (r) => mod.onSolved(r),
    visualState() {
      const s = formatTime(chip.epoch());
      return {
        time: s,
        clock: s.slice(11),
        unix: chip.unix(),
        running: mod.powered,
        lostPower: (chip.regs[0x0e]! & 0x01) !== 0,
        backupSwitchover: chip.backupSwitchover,
        trickleCharge: chip.trickleCharge,
        supply_ua: round(mod.powered ? CHIP_MA * 1000 : 0, 3),
      };
    },
    setProp(id, v) {
      if (id === "startTime") chip.base = startOf(v);
      else if (id === "lostPower") chip.regs[0x0e] = truthy(v) ? chip.regs[0x0e]! | 0x01 : chip.regs[0x0e]! & 0xfe;
    },
    interact(e) {
      if (e.kind === "set" && e.key === "time" && typeof e.value === "string") {
        const t = parseTime(e.value);
        if (t !== undefined) chip.setTime(t);
      }
    },
    diagnostics() {
      const out: Diagnostic[] = mod.diagnostics();
      if (badStart !== undefined) {
        out.push({ severity: "warning", code: "rtc-bad-start-time", message: `${ctx.id}: startTime '${badStart}' is not a date like 2026-01-01T12:00:00, so the clock starts at ${DEFAULT_START}. Set startTime as YYYY-MM-DDTHH:MM:SS.` });
      }
      if (chip.touched && chip.backupSwitchover === "off") {
        out.push({
          severity: "info",
          code: "rtc-backup-switchover-off",
          message: `${ctx.id}: the RV-3028's backup switchover is off (EEPROM 0x37 BSM = 00, how the chip ships), so its coin cell would not keep the time while the board is unpowered. Why: the chip only switches to the backup cell when BSM is 01 (direct) or 11 (level). Fix: once in setup(), write 0x37 with BSM = 11 (e.g. read 0x37, set bits 3:2, write it back, then EECMD 0x00 then 0x11 to store it), or call your library's backup-switchover function (Pimoroni's set-time example does it). In the simulator the time survives either way.`,
        });
      }
      if (chip.trickleCharge) {
        out.push({
          severity: "warning",
          code: "rtc-trickle-charge-primary-cell",
          message: `${ctx.id}: trickle charging is on (EEPROM 0x37 TCE = 1), but the breakout's backup cell is a non-rechargeable silver-oxide 337. Why: charging a primary cell can make it leak. Fix: clear TCE (bit 5 of 0x37) and store it (EECMD 0x00 then 0x11), unless you fitted a rechargeable cell or a supercap.`,
        });
      }
      return out;
    },
  };
};
