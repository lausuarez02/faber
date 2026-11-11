// What Jumper emulates on each board, per peripheral, and how we know (round 10, integration).
// One table: docs/boards.md is generated from it (pnpm gen), the parts library shows a board's row,
// and board-support.test.ts keeps it honest (every board part has a row, every "verified" cell names
// a test file that exists, planned boards say so).
//
// Status of a cell:
//   verified   a committed fixture test ran real firmware on this board (or its chip) and checked it
//   partial    works with a stated gap, or real firmware ran but not as a committed passing test
//   untested   code for it exists in the backend / emulator, but no real firmware has exercised it
//   no         not emulated: the firmware cannot use it in Jumper (test it on the real board)
//   n/a        the chip has no such peripheral

export type SupportStatus = "verified" | "partial" | "untested" | "no" | "n/a";

export interface SupportCell {
  status: SupportStatus;
  /** Why (for anything other than verified), or what exactly was checked. */
  note?: string;
  /** Test file that proves it (verified / partial). */
  test?: string;
}

export const SUPPORT_AREAS = ["boots", "gpio", "pwm", "adc", "irq", "uart", "i2c", "spi", "i2s", "rmt", "net", "ble"] as const;
export type SupportArea = (typeof SUPPORT_AREAS)[number];

export const AREA_LABEL: Record<SupportArea, string> = {
  boots: "Boots real firmware",
  gpio: "GPIO (+ pulls)",
  pwm: "PWM",
  adc: "ADC",
  irq: "Pin interrupts",
  uart: "UART",
  i2c: "I2C",
  spi: "SPI",
  i2s: "I2S",
  rmt: "NeoPixel / WS2812",
  net: "Wi-Fi / network",
  ble: "BLE",
};

export interface BoardSupport {
  /** Board part id. */
  board: string;
  /** Simulator backend (part.json mcu.backend). */
  backend: "avr8js" | "rp2040js" | "qemu-esp" | "renode";
  /** Where the emulator runs. */
  runs: string;
  areas: Record<SupportArea, SupportCell>;
  /** Firmware languages: verified ones, and the others with their status. */
  languages: { id: string; status: SupportStatus; note?: string }[];
}

// ------------------------------------------------------------------------------------------ tests

const T = {
  avrBlink: "packages/parts/src/blink.integration.test.ts",
  avrPwm: "packages/parts/src/pwm.integration.test.ts",
  avrLibs: "packages/parts/src/libs3.integration.test.ts",
  avrAdc: "packages/sim-backends/src/avr.test.ts",
  avrTwi: "packages/sim-backends/src/twi.test.ts",
  rpSession: "packages/session/test/rp2040-session.test.ts",
  rp: "packages/parts/src/rp2040.integration.test.ts",
  mpy: "services/runner/src/lang/lang.test.ts",
  espBoards: "packages/sim-backends/src/qemu-esp/boards.integration.test.ts",
  esp9: "packages/sim-backends/src/qemu-esp/qemu-esp.integration.test.ts",
  espBridge: "packages/sim-backends/src/qemu-esp/bridge.test.ts",
  espNet: "packages/device-net/test/firmware.integration.test.ts",
  renode: "packages/sim-backends/src/renode/boards.integration.test.ts",
  renodeParts: "packages/parts/src/renode.integration.test.ts",
} as const;

const v = (test: string, note?: string): SupportCell => ({ status: "verified", test, ...(note ? { note } : {}) });
const no = (note: string): SupportCell => ({ status: "no", note });
const na = (note = "the chip has none"): SupportCell => ({ status: "n/a", note });
const untested = (note: string): SupportCell => ({ status: "untested", note });

// ------------------------------------------------------------------------------------------ AVR

const avr = (board: string): BoardSupport => ({
  board,
  backend: "avr8js",
  runs: "in the page and in Node (avr8js)",
  areas: {
    boots: v(T.avrBlink),
    gpio: v(T.avrBlink),
    pwm: v(T.avrPwm),
    adc: v(T.avrAdc, "A0..A5 fed from the solved pin voltage (AVCC = vcc)"),
    irq: untested("avr8js models INT0 / INT1 and pin-change interrupts; no Jumper fixture uses attachInterrupt yet"),
    uart: v(T.avrBlink, "the hardware USART; on D0 / D1 bit by bit when a part listens"),
    i2c: v(T.avrTwi, "TWI master against real compiled firmware"),
    spi: v(T.avrTwi),
    i2s: na(),
    rmt: v(T.avrLibs, "FastLED bit-bangs a WS2812B strip on the Uno"),
    net: no("no network on the board; the ESP-01 Wi-Fi part (AT commands) reaches the sandbox network over Serial"),
    ble: na(),
  },
  languages: [
    { id: "arduino", status: "verified" },
    { id: "platformio", status: "untested", note: "image jumper/platformio:6.2.0-avr5.3.0-r1 built; Jumper's build path never ran (Docker failed in round 10)" },
  ],
});

// ------------------------------------------------------------------------------------------ RP2040

const rp = (board: string, boots: string): BoardSupport => ({
  board,
  backend: "rp2040js",
  runs: "in the page and in Node (rp2040js)",
  areas: {
    boots: v(boots),
    gpio: v(T.rp),
    pwm: v(T.rp, "analogWrite at arduino-pico's 1 kHz; tone()"),
    adc: v(T.rp, "12-bit ADC (10-bit analogRead)"),
    irq: untested("rp2040js models GPIO interrupts; no Jumper fixture uses attachInterrupt yet"),
    uart: v(T.rp, "Serial1 through the wires; USB serial for Serial"),
    i2c: v(T.rp),
    spi: v(T.rp),
    i2s: no("no I2S on the RP2040 (PIO-based I2S is not modelled as audio)"),
    rmt: v(T.avrLibs, "FastLED drives a WS2812B strip through PIO (checked on the XIAO RP2040; same chip on every RP2040 board)"),
    net: no("no network on the board"),
    ble: na(),
  },
  languages: [
    { id: "arduino", status: "verified" },
    { id: "micropython", status: board === "waveshare-rp2040-zero" ? "untested" : "verified", ...(board === "waveshare-rp2040-zero" ? { note: "the RPI_PICO build should run; not tested on this board" } : {}) },
  ],
});

// ------------------------------------------------------------------------------------------ ESP32 family

const JB5 = "bridged in the jb5 QEMU image and Jumper's backend (fake-QEMU protocol tests pass), but the image was never built and no real firmware has exercised it";

const esp = (board: string, chip: "esp32" | "esp32s3" | "esp32c3"): BoardSupport => ({
  board,
  backend: "qemu-esp",
  runs: "Espressif QEMU on this computer (Docker image jumper/qemu-esp), started by jumper serve",
  areas: {
    boots: v(T.espBoards, "proven on image jb3 (esp-app); not re-run on the merged jb5 image"),
    gpio: v(T.espBoards, "output, input with the internal pull-up; proven on jb3"),
    pwm: untested(`LEDC: ${JB5}`),
    adc: untested(`single-shot ADC fed by the solved pad voltage: ${JB5}`),
    irq: untested(`GPIO interrupts (edge and level): ${JB5}`),
    uart: { status: "partial", test: T.espBoards, note: `UART0 (Serial) verified on jb3; UART1 / UART2 ${JB5}` },
    i2c:
      chip === "esp32"
        ? { status: "partial", test: T.esp9, note: `I2C0 verified in round 9 (jb2); I2C1 and the repeated-START fix ${JB5}` }
        : untested(`QEMU had no I2C controller for the ${chip === "esp32s3" ? "ESP32-S3" : "ESP32-C3"}; jb5 adds one: ${JB5}`),
    spi: untested(`SPI2 / SPI3 master: ${JB5}`),
    i2s: no("Jumper's I2S bus and the MAX98357A / INMP441 parts exist, but QEMU has no I2S + DMA device yet"),
    rmt: untested(`RMT transmit (NeoPixel): ${JB5}`),
    net:
      chip === "esp32c3"
        ? { status: "partial", test: T.espNet, note: "an unmodified WiFi.h + HTTPS sketch ran 3x on an ESP32-C3 through the sandbox network (scan, DHCP, DNS, TLS 200, blocked host, weak signal, drop and rejoin) before Docker failed; the committed firmware test never ran. The radio itself is not emulated: Wi-Fi rides an emulated Ethernet card" }
        : untested("the netstack and the r3 Wi-Fi shim are chip-independent, but no firmware for this chip has run through them; the radio itself is not emulated"),
    ble: no("QEMU has no radio model"),
  },
  languages: [
    { id: "arduino", status: "verified", note: "simulation build jumper/arduino-esp32:3.3.12-r3; device build JUMPER_SIM=0" },
    chip === "esp32s3"
      ? { id: "micropython", status: "no", note: "the official S3 build stops at 'Failed to set QIE bit' (REPL on USB-OTG); needs a UART-REPL build" }
      : { id: "micropython", status: "partial", note: "the official build booted to its REPL in QEMU and drove a GPIO (spike run); the committed test never ran" },
    { id: "esp-idf", status: "untested", note: "image jumper/esp-idf:5.5.5-r1 built; no project build ran (Docker failed)" },
  ],
});

// ------------------------------------------------------------------------------------------ Renode boards

const renode = (board: string, o: { irq?: SupportCell; uart?: SupportCell; ble?: SupportCell } = {}): BoardSupport => ({
  board,
  backend: "renode",
  runs: "Renode 1.17 on this computer (Docker image jumper/renode, or a native Renode), started by jumper serve",
  areas: {
    boots: v(T.renode, "native Renode 1.17.0 (Docker path not re-run since Docker failed)"),
    gpio: v(T.renode, "every listed pin as output and input"),
    pwm: v(T.renode, "analogWrite duty"),
    adc: v(T.renode),
    irq: o.irq ?? v(T.renode, "three attachInterrupt presses"),
    uart: o.uart ?? v(T.renode, "the console UART; other UARTs do not reach parts"),
    i2c: v(T.renode, "Wire scan and register read on the default pins; each absent address costs ~130 ms of device time on STM32"),
    spi: v(T.renode, "default pins"),
    i2s: no("not bridged"),
    rmt: untested("no RMT on these chips; a bit-banged WS2812 should run in Renode, but its timing has not been tried"),
    net: no("no network interface on these boards in Renode (docs/network.md says what it would take)"),
    ble: o.ble ?? na(),
  },
  languages: [
    { id: "arduino", status: "verified" },
    { id: "micropython", status: "no", note: "official builds have a USB-only REPL (STM32F4) or expect the bootloader + SoftDevice (nRF52840)" },
  ],
});

const NRF_BLE = no("Renode has an nRF52840 RADIO model, but nothing is connected to it: BLE is not emulated");

export const BOARD_SUPPORT: readonly BoardSupport[] = [
  avr("arduino-uno"),
  avr("arduino-nano"),
  rp("raspberry-pi-pico", T.rp),
  rp("seeed-xiao-rp2040", T.rp),
  rp("waveshare-rp2040-zero", T.rpSession),
  esp("seeed-xiao-esp32s3", "esp32s3"),
  esp("seeed-xiao-esp32c3", "esp32c3"),
  esp("esp32-c3-supermini", "esp32c3"),
  esp("esp32-devkitc", "esp32"),
  esp("esp32-s3-devkitc-1", "esp32s3"),
  renode("stm32-bluepill"),
  renode("stm32-blackpill-f411"),
  renode("stm32-nucleo-f401re", { irq: no("attachInterrupt never fires on this board in Renode (PA8, PA10, PB5 tried; the Black Pill on the same platform works); the board stays planned") }),
  renode("seeed-xiao-nrf52840", { ble: NRF_BLE }),
  renode("arduino-nano-33-ble", { uart: { status: "partial", test: T.renode, note: "Serial1 TX works; Serial1 RX never delivers bytes (known gap)" }, ble: NRF_BLE }),
];

export function boardSupportOf(board: string): BoardSupport | undefined {
  return BOARD_SUPPORT.find((b) => b.board === board);
}

const MARK: Record<SupportStatus, string> = { verified: "✅ verified", partial: "🟡 partial", untested: "⚪ untested", no: "❌ no", "n/a": "n/a" };

/** One line per area, for a tooltip: "PWM: untested (…)". */
export function boardSupportSummary(b: BoardSupport): string {
  const by = (s: SupportStatus) => SUPPORT_AREAS.filter((a) => b.areas[a].status === s).map((a) => AREA_LABEL[a]);
  const parts = [
    by("verified").length ? `Verified: ${by("verified").join(", ")}` : "",
    by("partial").length ? `Partial: ${by("partial").join(", ")}` : "",
    by("untested").length ? `Written, not yet tested on real firmware: ${by("untested").join(", ")}` : "",
    by("no").length ? `Not emulated: ${by("no").join(", ")}` : "",
  ].filter(Boolean);
  return parts.join("\n");
}

/** docs/boards.md (generated by pnpm gen). `names` maps board id to its display name. */
export function boardSupportMarkdown(names: Record<string, { name: string; availability?: { status: string; reason: string } }>): string {
  const out: string[] = [];
  out.push("<!-- Generated by `pnpm gen` from packages/parts/src/board-support.ts. Edit that file, not this one. -->");
  out.push("# Boards: what Jumper emulates");
  out.push("");
  out.push("Every board, every peripheral, and how we know. Statuses:");
  out.push("");
  out.push("- **✅ verified**: a committed fixture test ran real firmware on this board (or its chip) and checked it (linked).");
  out.push("- **🟡 partial**: works with a stated gap, or real firmware ran but not as a committed passing test.");
  out.push("- **⚪ untested**: the code exists in the emulator and Jumper's backend, but no real firmware has exercised it yet. Treat it as not emulated until it is verified.");
  out.push("- **❌ no**: not emulated. The firmware cannot use it in Jumper; test it on the real board.");
  out.push("- **n/a**: the chip has no such peripheral.");
  out.push("");
  out.push("A board is placeable in the parts library only when its fixture test proves it boots real firmware and its listed buses work (part.json `availability`); the others are listed as planned with the reason.");
  out.push("");
  const cols = ["Board", "Runs", ...SUPPORT_AREAS.map((a) => AREA_LABEL[a]), "Languages"];
  out.push(`| ${cols.join(" | ")} |`);
  out.push(`| ${cols.map(() => "---").join(" | ")} |`);
  const short: Record<SupportStatus, string> = { verified: "✅", partial: "🟡", untested: "⚪", no: "❌", "n/a": "–" };
  for (const b of BOARD_SUPPORT) {
    const n = names[b.board];
    const planned = n?.availability?.status === "planned";
    const runs = b.backend === "avr8js" || b.backend === "rp2040js" ? "page" : b.backend === "qemu-esp" ? "QEMU" : "Renode";
    const langs = b.languages.map((l) => `${l.id} ${short[l.status]}`).join(", ");
    out.push(`| [${n?.name ?? b.board}](#${b.board})${planned ? " (planned)" : ""} | ${runs} | ${SUPPORT_AREAS.map((a) => short[b.areas[a].status]).join(" | ")} | ${langs} |`);
  }
  out.push("");
  out.push("## Per board");
  for (const b of BOARD_SUPPORT) {
    const n = names[b.board];
    out.push("");
    out.push(`### ${n?.name ?? b.board}`);
    out.push(`<a id="${b.board}"></a>`);
    out.push("");
    out.push(`Part \`${b.board}\`, backend \`${b.backend}\`: ${b.runs}.${n?.availability ? ` **${n.availability.status === "planned" ? "Planned" : "Available"}**: ${n.availability.reason}` : ""}`);
    out.push("");
    out.push("| Area | Status | Notes | Test |");
    out.push("| --- | --- | --- | --- |");
    for (const a of SUPPORT_AREAS) {
      const c = b.areas[a];
      out.push(`| ${AREA_LABEL[a]} | ${MARK[c.status]} | ${(c.note ?? "").replace(/\|/g, "\\|")} | ${c.test ? `[${c.test.split("/").pop()}](../${c.test})` : ""} |`);
    }
    out.push(`| Languages | | ${b.languages.map((l) => `${l.id}: ${MARK[l.status]}${l.note ? ` (${l.note})` : ""}`).join("; ")} | |`);
  }
  out.push("");
  out.push("## Gaps across boards");
  out.push("");
  out.push("- **Wi-Fi radio and BLE are not emulated anywhere.** ESP32 Wi-Fi sketches run unchanged through an emulated Ethernet card and Jumper's sandbox network (docs/network.md); signal, range and roaming are not modelled.");
  out.push("- **The merged ESP32 emulator image (jumper/qemu-esp:9.2.2-20260417-jb5) has not been built**: Docker Desktop on the integration machine was hung. Until it is built and the fixture tests re-run, ESP32 boards fail to start with \"image missing\" and a fix (`pnpm jumper setup esp32`).");
  out.push("- **Process-backend boards (QEMU, Renode) run only through `jumper serve`** (the page follows that run); the page itself runs AVR and RP2040 boards.");
  out.push("- **Renode starts on the first step and blocks the server thread for about 2.4 s** at start and on reset.");
  out.push("");
  return out.join("\n");
}
