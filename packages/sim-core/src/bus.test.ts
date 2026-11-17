import { describe, expect, it } from "vitest";
import { parseProject, type ProjectInput } from "@faber/project-format";
import {
  I2cBus,
  Simulation,
  SpiBus,
  createMcuBoardModel,
  createRegistry,
  decodeMonoFrame,
  bytesToBase64,
  base64ToBytes,
  monoLitCount,
  monoToAscii,
  type BackendFactory,
  type Fidelity,
  type I2cDevice,
  type McuBackend,
  type PartDefinition,
  type PartSpec,
  type PinState,
  type SpiDevice,
} from "./index.ts";

/** A register-file I2C target: write [reg, data…], read from the register pointer. */
class RegDevice implements I2cDevice {
  regs = new Uint8Array(256);
  ptr = 0;
  first = true;
  stops = 0;
  connects: { read: boolean; repeated: boolean }[] = [];
  constructor(public address: number) {}
  i2cAddress() {
    return this.address;
  }
  i2cConnect(read: boolean, repeated: boolean) {
    this.connects.push({ read, repeated });
    this.first = !read;
    return true;
  }
  i2cWrite(b: number) {
    if (this.first) {
      this.ptr = b;
      this.first = false;
    } else this.regs[this.ptr++ & 0xff] = b;
    return true;
  }
  i2cRead() {
    return this.regs[this.ptr++ & 0xff]!;
  }
  i2cStop() {
    this.stops++;
  }
}

describe("I2cBus", () => {
  it("addresses by 7-bit address, writes and reads registers, logs transactions", () => {
    const bus = new I2cBus();
    const dev = new RegDevice(0x3c);
    bus.attach("oled", dev);
    bus.start(false);
    expect(bus.connect(0x3c, false)).toBe(true);
    expect(bus.write(0x10)).toBe(true);
    expect(bus.write(0xab)).toBe(true);
    expect(bus.write(0xcd)).toBe(true);
    bus.stop();
    expect(dev.regs[0x10]).toBe(0xab);
    expect(dev.regs[0x11]).toBe(0xcd);

    // write pointer, repeated START, read two bytes
    bus.start(false);
    bus.connect(0x3c, false);
    bus.write(0x10);
    bus.start(true);
    expect(bus.connect(0x3c, true)).toBe(true);
    expect(bus.read(true)).toBe(0xab);
    expect(bus.read(false)).toBe(0xcd);
    bus.stop();
    expect(dev.connects.at(-1)).toEqual({ read: true, repeated: true });
    expect(dev.stops).toBe(2); // the repeated START is not a STOP

    const log = bus.transactions();
    expect(log.map((t) => [t.address, t.read, t.ack, t.count])).toEqual([
      [0x3c, false, true, 3],
      [0x3c, false, true, 1],
      [0x3c, true, true, 2],
    ]);
    expect(log[2]!.bytes).toEqual([0xab, 0xcd]);
    expect(log[2]!.partId).toBe("oled");
  });

  it("NACKs an empty address and reads 0xFF from an idle bus", () => {
    const bus = new I2cBus();
    bus.attach("oled", new RegDevice(0x3c));
    bus.start(false);
    expect(bus.connect(0x27, false)).toBe(false);
    expect(bus.write(1)).toBe(false);
    bus.stop();
    expect(bus.read(false)).toBe(0xff);
    expect(bus.transactions()[0]!.ack).toBe(false);
  });

  it("injects nack, nack-data, disconnect and garbage faults", () => {
    const bus = new I2cBus();
    const dev = new RegDevice(0x68);
    dev.regs[0] = 0x42;
    bus.attach("rtc", dev);
    expect(bus.list()).toEqual([{ partId: "rtc", address: 0x68 }]);

    bus.setFault("rtc", "nack");
    bus.start(false);
    expect(bus.connect(0x68, false)).toBe(false);
    bus.stop();
    expect(bus.list()[0]!.fault).toBe("nack");

    bus.setFault("rtc", "nack-data");
    bus.start(false);
    expect(bus.connect(0x68, false)).toBe(true);
    expect(bus.write(0)).toBe(false);
    bus.stop();

    bus.setFault("rtc", "disconnect");
    const before = dev.connects.length;
    bus.start(false);
    expect(bus.connect(0x68, true)).toBe(false);
    bus.stop();
    expect(dev.connects.length).toBe(before); // a disconnected device sees nothing

    bus.setFault("rtc", "garbage");
    bus.start(false);
    bus.connect(0x68, false);
    bus.write(0);
    bus.start(true);
    bus.connect(0x68, true);
    expect(bus.read(false)).toBe(0xff);
    bus.stop();

    bus.setFault("rtc", null);
    bus.start(false);
    bus.connect(0x68, false);
    bus.write(0);
    bus.start(true);
    bus.connect(0x68, true);
    expect(bus.read(false)).toBe(0x42);
    bus.stop();
  });
});

describe("SpiBus", () => {
  it("exchanges bytes only with selected devices", () => {
    const bus = new SpiBus();
    let cs = false;
    const got: number[] = [];
    const sel: boolean[] = [];
    const dev: SpiDevice = {
      spiTransfer: (b) => {
        got.push(b);
        return b ^ 0xff;
      },
      spiSelect: (s) => void sel.push(s),
    };
    bus.attach("tft", dev, () => cs);
    expect(bus.transfer(0x12)).toBe(0xff);
    cs = true;
    expect(bus.transfer(0x12)).toBe(0xed);
    bus.select("tft", true);
    bus.setFault("tft", "disconnect");
    expect(bus.transfer(0x34)).toBe(0xff);
    expect(got).toEqual([0x12]);
    expect(sel).toEqual([true]);
    expect(bus.bytes).toBe(3);
  });
});

describe("mono frames", () => {
  it("round-trips base64 and renders ASCII", () => {
    const bytes = new Uint8Array([0x80, 0x01, 0xff, 0x00, 0x7e]);
    expect(base64ToBytes(bytesToBase64(bytes))).toEqual(bytes);
    for (let n = 0; n < 7; n++) {
      const b = new Uint8Array(n).map((_, i) => i * 37);
      expect(base64ToBytes(bytesToBase64(b))).toEqual(b);
    }
    const f = decodeMonoFrame(bytesToBase64(new Uint8Array([0x81, 0x00, 0x18, 0x00])), 16, 2);
    expect(monoLitCount(f)).toBe(4);
    expect(monoToAscii(f)).toBe("#......#........\n...##...........");
    expect(() => decodeMonoFrame("AA==", 128, 64)).toThrow(/needs 1024/);
  });
});

// ------------------------------------------------------------------ Simulation wiring

const FID: Fidelity = {
  level: "stub",
  areas: {
    logic: { level: "ok", note: "test" },
    timing: { level: "n/a", note: "" },
    analog: { level: "n/a", note: "" },
    power: { level: "n/a", note: "" },
    radio: { level: "n/a", note: "" },
  },
  emulates: [],
  doesNotEmulate: [],
  testOnRealDevice: [],
};

class BusMcu implements McuBackend {
  readonly cyclesPerSecond = 1_000_000;
  readonly vcc = 5;
  readonly pinIds = ["D10", "D11", "D12", "D13", "A4", "A5"];
  readonly busPins = { i2c: { sda: "A4", scl: "A5" }, spi: { mosi: "D11", miso: "D12", sck: "D13", ss: "D10" } };
  cycles = 0;
  i2c?: I2cBus;
  spi?: SpiBus;
  pins = new Map<string, PinState>(this.pinIds.map((p) => [p, { mode: "input", value: 0 }]));
  cbs = new Set<(p: string, s: PinState, c: number) => void>();
  attachI2c(bus: I2cBus) {
    this.i2c = bus;
  }
  attachSpi(bus: SpiBus) {
    this.spi = bus;
  }
  load() {}
  reset() {}
  step(n: number) {
    this.cycles += n;
  }
  readPin(id: string) {
    return { ...this.pins.get(id)! };
  }
  setPinInput() {}
  drive(id: string, value: 0 | 1) {
    const s: PinState = { mode: "output", value };
    this.pins.set(id, s);
    for (const cb of this.cbs) cb(id, s, this.cycles);
  }
  onPinChange(cb: (p: string, s: PinState, c: number) => void) {
    this.cbs.add(cb);
    return () => void this.cbs.delete(cb);
  }
  onSerial() {
    return () => {};
  }
}

const boardSpec: PartSpec = {
  id: "bus-board",
  name: "Bus board",
  category: "board",
  description: "test",
  size: { w: 10, h: 10 },
  mcu: { backend: "fake", chip: "fake", clockHz: 1_000_000, vcc: 5 },
  pins: [
    { id: "A4", label: "SDA", x: 0, y: 0, type: "digital", protocols: ["i2c-sda"] },
    { id: "A5", label: "SCL", x: 0, y: 0, type: "digital", protocols: ["i2c-scl"] },
    { id: "D10", label: "10", x: 0, y: 0, type: "digital" },
    { id: "D11", label: "11", x: 0, y: 0, type: "digital", protocols: ["spi-mosi"] },
    { id: "D12", label: "12", x: 0, y: 0, type: "digital", protocols: ["spi-miso"] },
    { id: "D13", label: "13", x: 0, y: 0, type: "digital", protocols: ["spi-sck"] },
    { id: "GND", label: "GND", x: 0, y: 0, type: "ground" },
  ],
};

function i2cPartDef(id: string, address: number, pullUpOhms?: number): PartDefinition {
  return {
    spec: {
      id,
      name: id,
      category: "sensor",
      description: "test",
      size: { w: 10, h: 10 },
      pins: [
        { id: "SDA", label: "SDA", x: 0, y: 0, type: "digital", protocols: ["i2c-sda"] },
        { id: "SCL", label: "SCL", x: 0, y: 0, type: "digital", protocols: ["i2c-scl"] },
      ],
      bus: { i2c: { addresses: [address], ...(pullUpOhms ? { pullUpOhms } : {}) } },
    },
    fidelity: FID,
    svg: "",
    create: () => ({ stamp() {}, visualState: () => ({}), setProp() {}, i2c: new RegDevice(address) }),
  };
}

const spiDef: PartDefinition = {
  spec: {
    id: "spi-thing",
    name: "spi",
    category: "display",
    description: "test",
    size: { w: 10, h: 10 },
    pins: [
      { id: "MOSI", label: "MOSI", x: 0, y: 0, type: "digital", protocols: ["spi-mosi"] },
      { id: "SCK", label: "SCK", x: 0, y: 0, type: "digital", protocols: ["spi-sck"] },
      { id: "CS", label: "CS", x: 0, y: 0, type: "digital", protocols: ["spi-cs"] },
    ],
  },
  fidelity: FID,
  svg: "",
  create: () => {
    const log: string[] = [];
    return {
      stamp() {},
      visualState: () => ({ log: log.join(",") }),
      setProp() {},
      spi: { spiTransfer: (b) => (log.push(`x${b}`), 0x5a), spiSelect: (s) => void log.push(s ? "sel" : "desel") },
    };
  },
};

const registry = createRegistry([
  {
    spec: boardSpec,
    fidelity: FID,
    svg: "",
    create: (ctx) => createMcuBoardModel(ctx),
  },
  i2cPartDef("oled-test", 0x3c),
  i2cPartDef("oled-pullups", 0x3c, 4700),
  spiDef,
]);

function sim(parts: ProjectInput["parts"], wires: ProjectInput["wires"]) {
  const mcu = new BusMcu();
  const factory: BackendFactory = () => mcu;
  const project = parseProject({
    format: "faber/1",
    name: "bus",
    parts: [{ id: "b", type: "bus-board", x: 0, y: 0 }, ...(parts ?? [])],
    wires,
    firmware: { board: "b", artifact: "x.hex" },
  });
  return { sim: new Simulation({ project, registry, backendFactory: factory }), mcu };
}

const w = (id: string, a: string, b: string) => {
  const [ap, aq] = a.split(":");
  const [bp, bq] = b.split(":");
  return { id, from: { part: ap!, pin: aq! }, to: { part: bp!, pin: bq! } };
};

describe("Simulation buses", () => {
  it("attaches a correctly wired I2C part and hands the bus to the MCU", () => {
    const { sim: s, mcu } = sim([{ id: "oled", type: "oled-test", x: 0, y: 0 }], [w("w1", "oled:SDA", "b:A4"), w("w2", "oled:SCL", "b:A5")]);
    expect(mcu.i2c).toBe(s.i2c);
    expect(s.i2c.list()).toEqual([{ partId: "oled", address: 0x3c }]);
    mcu.i2c!.start(false);
    expect(mcu.i2c!.connect(0x3c, false)).toBe(true);
    mcu.i2c!.stop();
    const codes = s.diagnostics().map((d) => d.code);
    expect(codes).toContain("i2c-weak-pullups");
  });

  it("no weak-pullup note when the module has pull-ups", () => {
    const { sim: s } = sim([{ id: "oled", type: "oled-pullups", x: 0, y: 0 }], [w("w1", "oled:SDA", "b:A4"), w("w2", "oled:SCL", "b:A5")]);
    expect(s.diagnostics()).toEqual([]);
  });

  it("explains swapped, missing and conflicting wiring", () => {
    const swapped = sim([{ id: "oled", type: "oled-test", x: 0, y: 0 }], [w("w1", "oled:SDA", "b:A5"), w("w2", "oled:SCL", "b:A4")]).sim;
    const d1 = swapped.diagnostics().find((d) => d.code === "i2c-swapped");
    expect(d1?.message).toMatch(/SDA and SCL are swapped.*Wire oled:SDA → b:A4 and oled:SCL → b:A5/);
    expect(swapped.i2c.list()).toEqual([]);

    const half = sim([{ id: "oled", type: "oled-test", x: 0, y: 0 }], [w("w1", "oled:SDA", "b:A4")]).sim;
    const d2 = half.diagnostics().find((d) => d.code === "i2c-not-connected");
    expect(d2?.message).toMatch(/oled:SCL → b:A5 \(not wired\)/);

    const two = sim(
      [
        { id: "o1", type: "oled-test", x: 0, y: 0 },
        { id: "o2", type: "oled-pullups", x: 0, y: 0 },
      ],
      [w("w1", "o1:SDA", "b:A4"), w("w2", "o1:SCL", "b:A5"), w("w3", "o2:SDA", "b:A4"), w("w4", "o2:SCL", "b:A5")],
    ).sim;
    const conflicts = two.diagnostics().filter((d) => d.code === "i2c-address-conflict");
    expect(conflicts.map((d) => d.partId)).toEqual(["o1", "o2"]);
    expect(conflicts[0]!.message).toMatch(/share I2C address 0x3C/);
  });

  it("injects bus faults with readable errors for wrong use", () => {
    const { sim: s, mcu } = sim([{ id: "oled", type: "oled-test", x: 0, y: 0 }], [w("w1", "oled:SDA", "b:A4"), w("w2", "oled:SCL", "b:A5")]);
    s.setBusFault("oled", "nack");
    mcu.i2c!.start(false);
    expect(mcu.i2c!.connect(0x3c, false)).toBe(false);
    mcu.i2c!.stop();
    s.reset();
    expect(s.i2c.faultOf("oled")).toBe("nack"); // faults survive reset
    s.setBusFault("oled", null);
    expect(() => s.setBusFault("oled", "stuck" as never)).toThrow(/not an I2C fault.*nack, nack-data, disconnect, garbage/);
    expect(() => s.setBusFault("b", "nack")).toThrow(/not an I2C or SPI device/);
    expect(() => s.setBusFault("nope", "nack")).toThrow(/unknown part 'nope'.*b, oled/);
  });

  it("selects SPI devices from the CS net and reports CS edges", () => {
    const { sim: s, mcu } = sim(
      [{ id: "tft", type: "spi-thing", x: 0, y: 0 }],
      [w("w1", "tft:MOSI", "b:D11"), w("w2", "tft:SCK", "b:D13"), w("w3", "tft:CS", "b:D10")],
    );
    mcu.drive("D10", 1);
    expect(mcu.spi!.transfer(1)).toBe(0xff); // not selected
    mcu.drive("D10", 0);
    expect(mcu.spi!.transfer(2)).toBe(0x5a);
    mcu.drive("D10", 1);
    expect(s.partState("tft")!.log).toBe("sel,x2,desel");
  });

  it("explains an SPI device that is not wired to the bus", () => {
    const { sim: s } = sim([{ id: "tft", type: "spi-thing", x: 0, y: 0 }], [w("w1", "tft:MOSI", "b:D12")]);
    const codes = s.diagnostics().map((d) => d.code);
    expect(codes).toContain("spi-not-connected");
    expect(s.diagnostics().find((d) => d.code === "spi-not-connected")!.message).toMatch(/tft:MOSI → b:D11; tft:SCK → b:D13/);
  });
});
