// AVR TWI (I2C master) + SPI against real compiled firmware (golden fixtures, see fixtures/BUILD.md).
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { I2cBus, SpiBus, type I2cDevice, type McuBackend } from "@jumper/sim-core";
import { createBackend } from "./index.ts";

const fixture = (name: string) => readFileSync(fileURLToPath(new URL(`../fixtures/${name}`, import.meta.url)), "utf8");
const HZ = 16_000_000;

function runMs(mcu: McuBackend, ms: number): void {
  const target = mcu.cycles + Math.round((ms * HZ) / 1000);
  while (mcu.cycles < target) mcu.step(Math.min(16_000, target - mcu.cycles));
}

function serialOf(mcu: McuBackend): () => string {
  let out = "";
  mcu.onSerial((b) => {
    out += String.fromCharCode(b);
  });
  return () => out;
}

/** Minimal target: ACKs everything, answers reads with 0x43. */
class Echo implements I2cDevice {
  log: string[] = [];
  constructor(private readonly addr: number) {}
  i2cAddress() {
    return this.addr;
  }
  i2cConnect(read: boolean) {
    this.log.push(read ? "R" : "W");
    return true;
  }
  i2cWrite(b: number) {
    this.log.push(b.toString(16));
    return true;
  }
  i2cRead() {
    return 0x43;
  }
  i2cStop() {
    this.log.push("P");
  }
}

describe("avr8js TWI drives the I2C bus", { timeout: 60_000 }, () => {
  it("the I2C scanner finds exactly the attached addresses", () => {
    const mcu = createBackend("uno");
    const bus = new I2cBus("i2c0", () => mcu.cycles);
    mcu.attachI2c!(bus);
    bus.attach("oled", new Echo(0x3c));
    bus.attach("rtc", new Echo(0x68));
    const serial = serialOf(mcu);
    mcu.load(fixture("i2c_probe.hex"));
    runMs(mcu, 200);
    expect(serial()).toMatch(/^found 0x3C\r\nfound 0x68\r\nscan done 2\r\n/);
  });

  it("Wire.endTransmission() returns 0 with a device, 2 on an address NACK, 3 on a data NACK", () => {
    const mcu = createBackend("uno");
    const bus = new I2cBus("i2c0", () => mcu.cycles);
    mcu.attachI2c!(bus);
    const dev = new Echo(0x3c);
    bus.attach("oled", dev);
    const serial = serialOf(mcu);
    mcu.load(fixture("i2c_probe.hex"));
    runMs(mcu, 150);
    expect(serial()).toContain("tx 0 rx 1 43\r\n");
    // the device saw: address+write, control byte 0x00, 0xAF, STOP, then a read
    expect(dev.log.join(" ")).toContain("W 0 af P R P");

    bus.setFault("oled", "nack");
    const before = serial().length;
    runMs(mcu, 60);
    expect(serial().slice(before)).toContain("tx 2 rx 0\r\n");

    bus.setFault("oled", "nack-data");
    const mid = serial().length;
    runMs(mcu, 60);
    expect(serial().slice(mid)).toContain("tx 3 rx 1 43\r\n");

    bus.setFault("oled", "disconnect");
    const late = serial().length;
    runMs(mcu, 60);
    expect(serial().slice(late)).toContain("tx 2 rx 0\r\n");
  });

  it("takes realistic time on the wire (100 kHz: about 90 µs per byte)", () => {
    const mcu = createBackend("uno");
    const bus = new I2cBus("i2c0", () => mcu.cycles);
    mcu.attachI2c!(bus);
    bus.attach("oled", new Echo(0x3c));
    mcu.load(fixture("i2c_probe.hex"));
    runMs(mcu, 150);
    const log = bus.transactions();
    // consecutive scan probes: START + address + STOP ≈ 11 SCL periods of 160 cycles, plus Wire overhead
    const scan = log.filter((t) => !t.ack && t.address < 0x3c);
    expect(scan.length).toBeGreaterThan(10);
    const gaps = scan.slice(1, 10).map((t, i) => t.cycle - scan[i]!.cycle);
    for (const g of gaps) {
      expect(g).toBeGreaterThan(11 * 160);
      expect(g).toBeLessThan(11 * 160 + 2000);
    }
  });

  it("is deterministic: same firmware and devices give the same bus log", () => {
    const once = () => {
      const mcu = createBackend("uno");
      const bus = new I2cBus("i2c0", () => mcu.cycles);
      mcu.attachI2c!(bus);
      bus.attach("oled", new Echo(0x3c));
      mcu.load(fixture("i2c_probe.hex"));
      runMs(mcu, 120);
      return JSON.stringify(bus.transactions());
    };
    expect(once()).toBe(once());
  });
});

describe("avr8js SPI drives the SPI bus", () => {
  it("is attached and exposes the hardware bus pins", () => {
    const mcu = createBackend("uno");
    const spi = new SpiBus();
    mcu.attachSpi!(spi);
    expect(mcu.busPins).toEqual({
      i2c: { sda: "A4", scl: "A5" },
      spi: { mosi: "D11", miso: "D12", sck: "D13", ss: "D10" },
    });
  });

  it("exchanges bytes with the device selected by CS (D10), full duplex", { timeout: 30_000 }, () => {
    const mcu = createBackend("uno");
    const spi = new SpiBus();
    mcu.attachSpi!(spi);
    const seen: number[] = [];
    let i = 0;
    const reply = [0x00, 0xef, 0x40];
    spi.attach(
      "flash",
      {
        spiTransfer: (b) => {
          seen.push(b);
          return reply[i++ % 3]!;
        },
      },
      () => mcu.readPin("D10").mode === "output" && mcu.readPin("D10").value === 0,
    );
    const serial = serialOf(mcu);
    mcu.load(fixture("spi_probe.hex"));
    runMs(mcu, 50);
    expect(serial()).toMatch(/^spi 0 EF 40\r\n/);
    expect(seen.slice(0, 3)).toEqual([0x9f, 0, 0]);
    spi.setFault("flash", "disconnect");
    const before = serial().length;
    runMs(mcu, 30);
    expect(serial().slice(before)).toContain("spi FF FF FF");
  });
});
