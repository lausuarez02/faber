// ESP-01S Wi-Fi module (ESP8266) running Espressif's AT firmware 1.7, emulated at the protocol
// level: the board talks to it over a UART (SoftwareSerial on any two pins), it answers with the
// same text, in the same order, with realistic delays, and its TCP / TLS links go to the sandbox
// network the host passes in (ctx.services.network, see services/ai-gateway). No RF, no lwIP:
// what the firmware sees on its RX pin is what a real module prints. Deterministic as long as
// the network is (the mock AI is; a live AI call is not, and the network log says so).
import type { Diagnostic, PartModel, PartModelFactory, SandboxNetwork, SandboxSocket } from "@fabwright/sim-core";
import { UartReceiver, UartTransmitter } from "../../lib/softUart.ts";
import { num } from "../../lib/props.ts";

/** Delays in virtual ms, measured on an ESP-01S with AT 1.7.4 at 115200 baud (rounded). */
export const ESP_TIMING = {
  bootRomMs: 60,
  readyMs: 420,
  simpleMs: 3,
  joinOpenMs: 1500,
  joinSecuredMs: 2300,
  gotIpMs: 900,
  joinFailMs: { 1: 15000, 2: 3600, 3: 5200, 4: 6000 } as Record<number, number>,
  dnsMs: 25,
  sendAckMs: 2,
  sendOkMs: 12,
  closeMs: 6,
  pollMs: 5,
  radioMs: 100,
  reconnectMs: 2500,
};

/** ESP8266 absolute maximum on VCC and IO (datasheet: 3.6 V). */
const VMAX = 3.6;
const VMIN = 2.5;
/** Average current while associated (datasheet: 56 mA DTIM3, peaks 170 mA on TX). */
const AVG_MA = 80;
const MAX_LINKS = 5;

const BOOT_ROM = "\r\n ets Jan  8 2013,rst cause:2, boot mode:(3,7)\r\n\r\nload 0x40100000, len 2592, room 16\r\n";

type WifiState = "off" | "idle" | "connecting" | "connected" | "down";

interface Link {
  id: number;
  socket: SandboxSocket;
  type: "TCP" | "SSL";
  host: string;
  ip: string;
  port: number;
}

/** A network with Wi-Fi but no hosts, used when the host attached none: joins work, every host is "DNS Fail". */
const NO_INTERNET: SandboxNetwork = {
  accessPoints: () => [{ ssid: "FabwrightNet", rssi: -52, secured: false, channel: 6 }],
  join: (ssid) => (ssid === "FabwrightNet" ? 0 : 3),
  linkUp: () => true,
  resolve: () => undefined,
  open: () => ({ error: "unreachable" }),
};

/** "a","b",1 → ["a", "b", "1"] (quoted strings may contain commas and \" escapes). */
export function parseArgs(s: string): string[] {
  const out: string[] = [];
  let i = 0;
  while (i <= s.length) {
    if (s[i] === '"') {
      let v = "";
      i++;
      while (i < s.length && s[i] !== '"') {
        if (s[i] === "\\" && i + 1 < s.length) i++;
        v += s[i];
        i++;
      }
      i++; // closing quote
      out.push(v);
      while (i < s.length && s[i] !== ",") i++;
      i++;
    } else {
      const j = s.indexOf(",", i);
      out.push((j < 0 ? s.slice(i) : s.slice(i, j)).trim());
      if (j < 0) break;
      i = j + 1;
    }
  }
  return out;
}

export const create: PartModelFactory = (ctx): PartModel => {
  const net: SandboxNetwork = (ctx.services?.network as SandboxNetwork | undefined) ?? NO_INTERNET;
  const hasNetwork = ctx.services?.network !== undefined;
  let baud = num(ctx.props.baud, 115200);
  let vcc = 0;
  let maxIo = 0;
  let powered = false;
  let enabled = true;
  let running = false; // booted and accepting AT commands
  let echo = true;
  let mux = 0;
  let mode = 1;
  let wifi: WifiState = "off";
  let ssid = "";
  let savedAp: { ssid: string; pwd: string } | undefined;
  let ip = "";
  let radioFault = false;
  let busyUntil = -1;
  let line = "";
  let sendMode: { id: number; left: number; data: string } | undefined;
  let lastCommand = "";
  let rxBytes = 0;
  let commands = 0;
  const links = new Map<number, Link>();
  const timers = new Set<() => void>();
  let polling = false;

  const tx = new UartTransmitter(ctx, () => baud, () => ctx.requestSolve());
  const rx = new UartReceiver(ctx, "RX", () => baud, (b) => onByte(b));

  const at = (delayMs: number, fn: () => void): void => {
    if (!ctx.schedule) return;
    let cancel: () => void = () => {};
    cancel = ctx.schedule(delayMs, () => {
      timers.delete(cancel);
      fn();
    });
    timers.add(cancel);
  };
  const clearTimers = () => {
    for (const c of timers) c();
    timers.clear();
    polling = false;
  };
  const say = (text: string) => tx.send(text);

  // ------------------------------------------------------------------ power and boot

  const shutDown = () => {
    clearTimers();
    tx.clear();
    for (const l of links.values()) l.socket.close(ctx.now());
    links.clear();
    if (wifi === "connected") net.leave?.(ctx.now(), ctx.id);
    running = false;
    wifi = "off";
    ip = "";
    sendMode = undefined;
    line = "";
    busyUntil = -1;
  };

  const boot = () => {
    shutDown();
    wifi = "idle";
    echo = true;
    mux = 0;
    at(ESP_TIMING.bootRomMs, () => tx.send(BOOT_ROM, 74880));
    at(ESP_TIMING.readyMs, () => {
      running = true;
      say("\r\nready\r\n");
      if (savedAp) at(ESP_TIMING.reconnectMs, () => autoJoin());
      startRadio();
    });
  };

  // ------------------------------------------------------------------ Wi-Fi

  const radioUp = () => !radioFault && net.linkUp();

  const dropWifi = () => {
    for (const l of links.values()) {
      l.socket.close(ctx.now());
      say(mux ? `${l.id},CLOSED\r\n` : "CLOSED\r\n");
    }
    links.clear();
    if (wifi === "connected" || wifi === "connecting") say("WIFI DISCONNECT\r\n");
    net.leave?.(ctx.now(), ctx.id);
    wifi = "down";
    ip = "";
  };

  const autoJoin = () => {
    if (!running || !savedAp || wifi === "connected" || wifi === "connecting" || !radioUp()) return;
    const code = net.join(savedAp.ssid, savedAp.pwd, ctx.now(), ctx.id);
    if (code !== 0) return;
    wifi = "connecting";
    const secured = net.accessPoints().find((a) => a.ssid === savedAp!.ssid)?.secured ?? false;
    at(secured ? ESP_TIMING.joinSecuredMs : ESP_TIMING.joinOpenMs, () => {
      if (!radioUp()) return;
      say("WIFI CONNECTED\r\n");
      at(ESP_TIMING.gotIpMs, () => {
        if (!radioUp()) return;
        wifi = "connected";
        ssid = savedAp!.ssid;
        ip = "192.168.4.23";
        say("WIFI GOT IP\r\n");
      });
    });
  };

  /** Heartbeat while powered: notices the Wi-Fi going away and coming back (auto-reconnect, as the AT firmware does). */
  const startRadio = () => {
    let wasUp = radioUp();
    const beat = () => {
      if (!running) return;
      const up = radioUp();
      if (!up && wasUp) dropWifi();
      if (up && !wasUp && savedAp) at(ESP_TIMING.reconnectMs, () => autoJoin());
      wasUp = up;
      at(ESP_TIMING.radioMs, beat);
    };
    at(ESP_TIMING.radioMs, beat);
  };

  // ------------------------------------------------------------------ links

  const ensurePolling = () => {
    if (polling || links.size === 0) return;
    polling = true;
    const poll = () => {
      if (links.size === 0) {
        polling = false;
        return;
      }
      const t = ctx.now();
      for (const l of [...links.values()]) {
        const { data, closed } = l.socket.read(t);
        if (data.length > 0) {
          for (let i = 0; i < data.length; i += 1460) {
            const chunk = data.slice(i, i + 1460);
            say(mux ? `\r\n+IPD,${l.id},${chunk.length}:${chunk}` : `\r\n+IPD,${chunk.length}:${chunk}`);
          }
        }
        if (closed) {
          links.delete(l.id);
          say(mux ? `${l.id},CLOSED\r\n` : "CLOSED\r\n");
        }
      }
      at(ESP_TIMING.pollMs, poll);
    };
    at(ESP_TIMING.pollMs, poll);
  };

  // ------------------------------------------------------------------ AT commands

  const ok = (delay = ESP_TIMING.simpleMs, before = "") => at(delay, () => say(`${before}\r\nOK\r\n`));
  const error = (before = "", delay = ESP_TIMING.simpleMs) => at(delay, () => say(`${before}\r\nERROR\r\n`));
  const busyFor = (ms: number) => {
    busyUntil = ctx.now() + ms;
  };

  const command = (cmdLine: string) => {
    commands++;
    lastCommand = cmdLine.slice(0, 48);
    if (echo) say(`${cmdLine}\r\r\n`);
    if (ctx.now() < busyUntil) {
      at(1, () => say("busy p...\r\n"));
      return;
    }
    const m = /^AT(?:\+([A-Z_]+))?(=|\?)?(.*)$/i.exec(cmdLine);
    if (!m) return error();
    const name = (m[1] ?? "").toUpperCase();
    const op = m[2] ?? "";
    const args = op === "=" ? parseArgs(m[3] ?? "") : [];
    if (cmdLine.toUpperCase() === "AT") return ok();
    if (/^ATE[01]$/i.test(cmdLine)) {
      echo = cmdLine[3] === "1";
      return ok();
    }
    switch (name) {
      case "RST":
        at(ESP_TIMING.simpleMs, () => {
          say("\r\nOK\r\n");
          at(20, () => boot());
        });
        return;
      case "GMR":
        return ok(ESP_TIMING.simpleMs, "AT version:1.7.4.0(Fabwright sandbox emulation)\r\nSDK version:3.0.4\r\ncompile time:Fabwright\r\n");
      case "UART":
      case "UART_CUR":
      case "UART_DEF":
      case "CIOBAUD": {
        const b = Number(args[0]);
        if (![9600, 19200, 38400, 57600, 74880, 115200, 230400].includes(b)) return error();
        // OK goes out at the old rate, then the module switches.
        at(ESP_TIMING.simpleMs, () => {
          say("\r\nOK\r\n");
          at(5, () => {
            baud = b;
          });
        });
        return;
      }
      case "CWMODE":
      case "CWMODE_CUR":
      case "CWMODE_DEF":
        if (op === "?") return ok(ESP_TIMING.simpleMs, `+${name}:${mode}\r\n`);
        if (!["1", "2", "3"].includes(args[0] ?? "")) return error();
        mode = Number(args[0]);
        return ok();
      case "CWLAP": {
        if (mode === 2) return error();
        const aps = radioUp() ? net.accessPoints() : [];
        const list = aps.map((a) => `+CWLAP:(${a.secured ? 3 : 0},"${a.ssid}",${a.rssi},"de:ad:be:ef:00:0${a.channel % 10}",${a.channel},-6,0)\r\n`).join("");
        busyFor(2000);
        return ok(2000, list);
      }
      case "CWJAP":
      case "CWJAP_CUR":
      case "CWJAP_DEF": {
        if (op === "?") {
          return ok(ESP_TIMING.simpleMs, wifi === "connected" ? `+${name}:"${ssid}","de:ad:be:ef:00:06",6,-52\r\n` : "No AP\r\n");
        }
        if (mode === 2) return error();
        const [s = "", p = ""] = args;
        if (wifi === "connected") net.leave?.(ctx.now(), ctx.id);
        wifi = "connecting";
        ip = "";
        const code = radioUp() ? net.join(s, p, ctx.now(), ctx.id) : 3;
        if (name !== "CWJAP_CUR") savedAp = { ssid: s, pwd: p };
        if (code !== 0) {
          const d = ESP_TIMING.joinFailMs[code] ?? 5000;
          busyFor(d);
          at(d, () => {
            wifi = "idle";
            say(`+CWJAP:${code}\r\n\r\nFAIL\r\n`);
          });
          return;
        }
        const secured = net.accessPoints().find((a) => a.ssid === s)?.secured ?? false;
        const t1 = secured ? ESP_TIMING.joinSecuredMs : ESP_TIMING.joinOpenMs;
        busyFor(t1 + ESP_TIMING.gotIpMs + 5);
        at(t1, () => {
          say("WIFI CONNECTED\r\n");
          at(ESP_TIMING.gotIpMs, () => {
            if (!radioUp()) {
              wifi = "down";
              return say("WIFI DISCONNECT\r\n\r\nFAIL\r\n");
            }
            wifi = "connected";
            ssid = s;
            ip = "192.168.4.23";
            say("WIFI GOT IP\r\n\r\nOK\r\n");
          });
        });
        return;
      }
      case "CWQAP":
        if (wifi === "connected") {
          for (const l of links.values()) l.socket.close(ctx.now());
          links.clear();
          net.leave?.(ctx.now(), ctx.id);
          wifi = "idle";
          ip = "";
          return at(ESP_TIMING.simpleMs, () => say("\r\nOK\r\nWIFI DISCONNECT\r\n"));
        }
        return ok();
      case "CWAUTOCONN":
        return ok();
      case "CIFSR":
        return ok(ESP_TIMING.simpleMs, `+CIFSR:STAIP,"${wifi === "connected" ? ip : "0.0.0.0"}"\r\n+CIFSR:STAMAC,"5c:cf:7f:00:00:01"\r\n`);
      case "CIPMUX":
        if (op === "?") return ok(ESP_TIMING.simpleMs, `+CIPMUX:${mux}\r\n`);
        if (links.size > 0) return error("link is builded\r\n");
        mux = args[0] === "1" ? 1 : 0;
        return ok();
      case "CIPMODE":
        if (args[0] === "1") return error(); // transparent mode is not emulated
        return ok();
      case "CIPDOMAIN": {
        if (wifi !== "connected") return error();
        const a = net.resolve(args[0] ?? "");
        return a ? ok(ESP_TIMING.dnsMs, `+CIPDOMAIN:${a}\r\n`) : error("DNS Fail\r\n", ESP_TIMING.dnsMs);
      }
      case "PING": {
        if (wifi !== "connected") return error();
        const a = net.resolve(args[0] ?? "");
        return a ? ok(30, "+12\r\n") : error("+timeout\r\n", 1000);
      }
      case "CIPSTATUS": {
        const status = wifi !== "connected" ? 5 : links.size > 0 ? 3 : 2;
        const rows = [...links.values()].map((l) => `+CIPSTATUS:${l.id},"${l.type}","${l.ip}",${l.port},4096,0\r\n`).join("");
        return ok(ESP_TIMING.simpleMs, `STATUS:${status}\r\n${rows}`);
      }
      case "CIPSTART": {
        const a = mux ? args.slice(1) : args;
        const id = mux ? Number(args[0]) : 0;
        const [type = "", host = "", portS = ""] = a;
        const port = Number(portS);
        const t = type.toUpperCase();
        if (!["TCP", "SSL"].includes(t) || !host || !Number.isFinite(port)) return error();
        if (mux && (!Number.isInteger(id) || id < 0 || id >= MAX_LINKS)) return error();
        if (links.has(id)) return error("ALREADY CONNECTED\r\n");
        if (wifi !== "connected") return error("no ip\r\n");
        const addr = net.resolve(host);
        if (!addr) return error("DNS Fail\r\n", ESP_TIMING.dnsMs);
        const sock = net.open({ host, ip: addr, port, tls: t === "SSL", tMs: ctx.now(), partId: ctx.id });
        if ("error" in sock) {
          busyFor(ESP_TIMING.dnsMs + 40);
          return at(ESP_TIMING.dnsMs + 40, () => say(`\r\nERROR\r\n${mux ? `${id},` : ""}CLOSED\r\n`));
        }
        const d = ESP_TIMING.dnsMs + sock.connectMs;
        busyFor(d);
        at(d, () => {
          if (wifi !== "connected") {
            sock.close(ctx.now());
            return say("\r\nERROR\r\nCLOSED\r\n");
          }
          links.set(id, { id, socket: sock, type: t as "TCP" | "SSL", host, ip: addr, port });
          say(mux ? `${id},CONNECT\r\n\r\nOK\r\n` : "CONNECT\r\n\r\nOK\r\n");
          ensurePolling();
        });
        return;
      }
      case "CIPSEND": {
        const id = mux ? Number(args[0]) : 0;
        const len = Number(mux ? args[1] : args[0]);
        if (!Number.isInteger(len) || len <= 0 || len > 2048) return error();
        if (!links.has(id)) return error("link is not valid\r\n");
        sendMode = { id, left: len, data: "" };
        at(ESP_TIMING.sendAckMs, () => say("\r\nOK\r\n> "));
        return;
      }
      case "CIPCLOSE": {
        const id = mux ? Number(args[0] ?? 5) : 0;
        const targets = id === 5 ? [...links.keys()] : links.has(id) ? [id] : [];
        if (targets.length === 0) return error();
        for (const k of targets) {
          links.get(k)!.socket.close(ctx.now());
          links.delete(k);
        }
        return at(ESP_TIMING.closeMs, () => say(`${targets.map((k) => (mux ? `${k},CLOSED` : "CLOSED")).join("\r\n")}\r\n\r\nOK\r\n`));
      }
      case "CIPSERVER":
      case "CIPSTO":
      case "CIPDINFO":
      case "SLEEP":
      case "CWDHCP":
      case "CWHOSTNAME":
      case "SYSSTORE":
        return ok();
      default:
        return error();
    }
  };

  const onByte = (b: number) => {
    if (!powered || !enabled || !running) return;
    rxBytes++;
    if (sendMode) {
      sendMode.data += String.fromCharCode(b);
      sendMode.left--;
      if (sendMode.left === 0) {
        const { id, data } = sendMode;
        sendMode = undefined;
        const link = links.get(id);
        at(1, () => say(`\r\nRecv ${data.length} bytes\r\n`));
        // Air time at 11 Mbit/s is negligible; the module answers after its TCP ACK.
        at(ESP_TIMING.sendOkMs, () => {
          if (!link || !links.has(id)) return say("\r\nSEND FAIL\r\n");
          link.socket.write(data, ctx.now());
          say(mux ? `\r\nSEND OK\r\n` : "\r\nSEND OK\r\n");
          ensurePolling();
        });
      }
      return;
    }
    if (b === 0x0a) {
      const cmd = line.replace(/\r$/, "");
      line = "";
      if (cmd.length > 0) command(cmd);
      return;
    }
    if (line.length < 256) line += String.fromCharCode(b);
  };

  // ------------------------------------------------------------------ PartModel

  return {
    stamp(c) {
      const v = ctx.node("VCC");
      if (powered) c.resistor(v, "0", 3.3 / (AVG_MA / 1000), { id: "load" });
      c.resistor(ctx.node("EN"), v, 12_000, { id: "en-pullup" });
      c.resistor(ctx.node("RST"), v, 12_000, { id: "rst-pullup" });
      // TX: the ESP8266 drives 3.3 V logic through ~40 Ω.
      c.voltageSource(ctx.node("TX"), "0", powered ? (tx.level ? Math.min(vcc, 3.3) : 0) : 0, powered ? 40 : 1e9, { id: "tx" });
    },
    onSolved(r) {
      vcc = r.voltage(ctx.node("VCC")) - r.voltage(ctx.node("GND"));
      const io = Math.max(r.voltage(ctx.node("RX")), r.voltage(ctx.node("EN")), r.voltage(ctx.node("RST")));
      maxIo = Math.max(maxIo, io);
      const nowPowered = vcc >= VMIN && vcc <= VMAX + 0.4;
      const en = r.voltage(ctx.node("EN")) > vcc * 0.5 && r.voltage(ctx.node("RST")) > vcc * 0.5;
      if (nowPowered && en && !(powered && enabled)) {
        powered = true;
        enabled = true;
        boot();
        return;
      }
      if ((!nowPowered || !en) && powered && enabled) shutDown();
      powered = nowPowered;
      enabled = en;
    },
    visualState() {
      const t = ctx.now();
      return {
        powered: powered && enabled,
        wifi: powered && enabled ? wifi : "off",
        online: wifi === "connected",
        ssid: wifi === "connected" ? ssid : "",
        ip,
        links: links.size,
        led: powered && enabled && (tx.pending > 0 || (tx.lastActivity >= 0 && t - tx.lastActivity < 30)),
        baud,
        lastCommand,
        commands,
        rxBytes,
        txBytes: tx.bytes,
        framingErrors: rx.framingErrors,
        radioFault,
        network: hasNetwork ? "sandbox" : "none",
        powerOpacity: powered ? 1 : 0,
        ledOpacity: powered && enabled && (tx.pending > 0 || (tx.lastActivity >= 0 && t - tx.lastActivity < 30)) ? 1 : 0,
      };
    },
    setProp(id, value) {
      if (id === "baud") baud = num(value, 115200);
    },
    interact(e) {
      if (e.kind === "set" && (e.key === "wifi" || e.key === "radio")) {
        const v = String(e.value).toLowerCase();
        radioFault = ["down", "drop", "off", "false", "0"].includes(v);
      }
    },
    diagnostics(): Diagnostic[] {
      const out: Diagnostic[] = [];
      if (vcc > VMAX + 0.4) {
        out.push({ severity: "error", code: "esp-overvoltage", pin: "VCC", message: `ESP-01 VCC is ${vcc.toFixed(1)} V: the ESP8266 is a 3.3 V chip (absolute max 3.6 V) and 5 V destroys it. Wire VCC to 3V3, or better a separate 3.3 V regulator (AMS1117-3.3) that can give 300 mA.` });
      } else if (vcc > 0.3 && vcc < VMIN) {
        out.push({ severity: "warning", code: "esp-undervoltage", pin: "VCC", message: `ESP-01 VCC is only ${vcc.toFixed(1)} V, so it stays off (needs 3.0 to 3.6 V). Wire VCC to 3V3.` });
      }
      if (maxIo > VMAX + 0.4 && vcc <= VMAX + 0.4) {
        out.push({ severity: "warning", code: "esp-rx-5v", pin: "RX", message: `ESP-01 RX (or EN/RST) sees ${maxIo.toFixed(1)} V from a 5 V pin. The ESP8266 is specified for 3.6 V max on IO; many modules survive, some die. Put a 1 kΩ / 2 kΩ divider between the Uno TX pin and ESP RX (1 kΩ from the Uno pin, 2 kΩ to GND, ESP RX in the middle).` });
      }
      if (powered && !hasNetwork) {
        out.push({ severity: "info", code: "esp-no-network", message: "No sandbox network is attached to this simulation, so the ESP-01 can join FabwrightNet but every host answers DNS Fail. The session and the web app attach it (services/ai-gateway); in a bare Simulation pass services: { network }." });
      }
      if (powered && rx.framingErrors > 4 && commands === 0) {
        out.push({ severity: "warning", code: "esp-baud-mismatch", pin: "RX", message: `ESP-01 is receiving garbage (${rx.framingErrors} framing errors, no valid command): the sketch and the module use different baud rates. The module is at ${baud} baud; use esp.begin(${baud}), or send AT+UART_DEF=9600,8,1,0,0 at ${baud} once and switch to 9600.` });
      }
      if (powered && ctx.node("RX") === `${ctx.id}:RX`) {
        out.push({ severity: "info", code: "esp-rx-unwired", pin: "RX", message: "ESP-01 RX is not driven by a board pin, so it never hears a command. Wire it to the pin you pass to SoftwareSerial as TX (e.g. D3), through a 1k/2k divider on a 5 V board." });
      }
      return out;
    },
    dispose() {
      clearTimers();
      rx.dispose();
    },
  };
};

