import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { parseProject } from "@faber/project-format";
import { Simulation, type SandboxNetwork, type SandboxSocket } from "@faber/sim-core";
import { backendFactory } from "@faber/sim-backends";
import { registry } from "../../registry.gen.ts";
import { parseArgs } from "./model.ts";

/** A tiny deterministic network: FaberNet (open) and ai.faber answering /health after 300 ms. */
function fakeNetwork(log: string[]): SandboxNetwork & { down: boolean } {
  const net = {
    down: false,
    accessPoints: () => (net.down ? [] : [{ ssid: "FaberNet", rssi: -52, secured: false, channel: 6 }]),
    join: (ssid: string) => (net.down || ssid !== "FaberNet" ? (3 as const) : (0 as const)),
    linkUp: () => !net.down,
    resolve: (h: string) => (h === "ai.faber" ? "10.0.0.2" : undefined),
    open: (): SandboxSocket => {
      let req = "";
      let at = -1;
      let sent = false;
      return {
        connectMs: 40,
        pending: false,
        write(d, t) {
          req += d;
          log.push(req);
          if (req.includes("\r\n\r\n")) at = t + 300;
        },
        read(t) {
          if (at < 0 || t < at) return { data: "", closed: false };
          if (!sent) {
            sent = true;
            return { data: "HTTP/1.0 200 OK\r\nContent-Length: 6\r\n\r\nok|hi!", closed: false };
          }
          return { data: "", closed: t > at + 8 };
        },
        close() {},
      };
    },
  };
  return net;
}

function bench(network?: SandboxNetwork, props: Record<string, string> = {}) {
  const hex = readFileSync(new URL("./example.hex", import.meta.url), "utf8");
  const w = (id: string, a: string, b: string) => {
    const [ap, aq] = a.split(":");
    const [bp, bq] = b.split(":");
    return { id, from: { part: ap!, pin: aq! }, to: { part: bp!, pin: bq! } };
  };
  const project = parseProject({
    format: "faber/1",
    name: "esp bench",
    parts: [
      { id: "uno", type: "arduino-uno", x: 0, y: 0 },
      { id: "esp", type: "esp01-wifi", x: 0, y: 0, props },
      { id: "r1", type: "resistor", x: 0, y: 0, props: { resistance: 1000 } },
      { id: "r2", type: "resistor", x: 0, y: 0, props: { resistance: 2000 } },
    ],
    wires: [
      w("w1", "esp:VCC", "uno:3V3"),
      w("w2", "esp:GND", "uno:GND.1"),
      w("w3", "esp:TX", "uno:D2"),
      w("w4", "uno:D3", "r1:1"),
      w("w5", "r1:2", "esp:RX"),
      w("w6", "esp:RX", "r2:1"),
      w("w7", "r2:2", "uno:GND.2"),
    ],
    firmware: { board: "uno", artifact: "example.hex" },
  });
  return new Simulation({ project, registry, backendFactory, firmware: hex, ...(network ? { services: { network } } : {}) });
}

describe("esp01-wifi: AT argument parsing", () => {
  it("splits quoted and bare arguments", () => {
    expect(parseArgs('"TCP","ai.faber",80')).toEqual(["TCP", "ai.faber", "80"]);
    expect(parseArgs('"Faber,Net","p\\"w"')).toEqual(["Faber,Net", 'p"w']);
    expect(parseArgs("9600,8,1,0,0")).toEqual(["9600", "8", "1", "0", "0"]);
  });
});

describe("esp01-wifi: real firmware (SoftwareSerial, AT 1.7 protocol)", () => {
  it("switches a 115200-baud module to 9600, joins FaberNet and makes an HTTP request through a 1k/2k divider", () => {
    const log: string[] = [];
    const sim = bench(fakeNetwork(log));
    sim.runFor(7000);
    const out = sim.serialText();
    if (process.env.ESP_DEBUG) console.log(JSON.stringify(out), JSON.stringify(sim.partState("esp")));
    expect(out).toContain("[no answer at 9600, switching the module from 115200]");
    expect(out).toContain("WIFI CONNECTED");
    expect(out).toContain("WIFI GOT IP");
    expect(out).toContain("[joined]");
    expect(out).toContain("CONNECT");
    expect(out).toContain("Recv 40 bytes");
    expect(out).toContain("SEND OK");
    expect(out).toContain("+IPD,44:HTTP/1.0 200 OK");
    expect(out).toContain("ok|hi!");
    expect(out).toContain("CLOSED");
    expect(out).toContain("[done]");
    expect(log.at(-1)).toBe("GET /health HTTP/1.0\r\nHost: ai.faber\r\n\r\n");
    const s = sim.partState("esp")!;
    expect(s.baud).toBe(9600);
    expect(s.online).toBe(true);
    expect(s.ssid).toBe("FaberNet");
    expect(sim.diagnostics().filter((d) => d.partId === "esp" && d.severity !== "info")).toEqual([]);
  }, 60_000);

  it("a module already at 9600 answers the first AT", () => {
    const sim = bench(fakeNetwork([]), { baud: "9600" });
    sim.runFor(4000);
    expect(sim.serialText()).not.toContain("switching the module");
    expect(sim.serialText()).toContain("[joined]");
  }, 60_000);

  it("without a sandbox network every host is DNS Fail, and the part says why", () => {
    const sim = bench(undefined, { baud: "9600" });
    sim.runFor(4500);
    expect(sim.serialText()).toContain("DNS Fail");
    expect(sim.diagnostics().map((d) => d.code)).toContain("esp-no-network");
  }, 60_000);

  it("is reported when wired to 5 V", () => {
    const sim = bench(fakeNetwork([]));
    void sim;
    const project = parseProject({
      format: "faber/1",
      name: "x",
      parts: [{ id: "uno", type: "arduino-uno", x: 0, y: 0 }, { id: "esp", type: "esp01-wifi", x: 0, y: 0 }],
      wires: [{ id: "w1", from: { part: "esp", pin: "VCC" }, to: { part: "uno", pin: "5V" } }],
    });
    const s2 = new Simulation({ project, registry, backendFactory });
    expect(s2.diagnostics().map((d) => d.code)).toContain("esp-overvoltage");
  });
});
