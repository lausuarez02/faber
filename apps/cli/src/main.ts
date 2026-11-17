import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { parseArgs } from "node:util";
import { stringify } from "yaml";
import { FabwrightError, ProjectSession, registerProject, TOOLS } from "@fabwright/session";

/**
 * `fabwright`: the same operations as the MCP tools, as subcommands. Human output is YAML; --json prints
 * the exact tool result as one JSON line. Exit code 0 = ok, 1 = the operation failed (or tests failed /
 * design errors), 2 = bad command line.
 */

const HELP = `fabwright: hardware sandbox CLI (same operations as the MCP server)

Usage: fabwright <command> [args] [--project <dir>] [--json]

Project
  new <dir> [--template blank|uno|nano|blink|pico-micropython|...] [--name N] [--overwrite]
  status                                  project summary (get_project)
  parts [query] [--category C]            search the catalog
  part <type>                             pins, wiring, example code
  place <type> [--id I] [--x X --y Y] [--rotation R] [--prop k=v]... [--why W]
  move <id> [--x X] [--y Y] [--rotation R]
  remove <id>                             part, wire or test scenario
  connect <from> <to> [--color C]         e.g. fabwright connect uno.D13 r1.1
  disconnect <wire> | --from P [--to P]
  set <id> <prop> <value>                 set_part_property
  libs <name>...                          set_libraries
  write <path> [--from local-file]        write_file (content from --from or stdin)
  read <path>                             read_file
  files                                   list_files
  create-part <part.json> [--svg F]       make a part the catalog lacks (create_part; docs/custom-parts.md)
  update-part <id> [part.json] [--svg F | --no-svg]   change it (update_part)
  project-parts                           this project's agent-made parts (list_project_parts)
Firmware and simulation
  firmware <language> [--firmware ID@v] [--target T] [--env E]   set_firmware: arduino | micropython | esp-idf | platformio
  setup [family|language|list]           install natively (no Docker needed): all families, or one of
                                          avr, rp2040, esp32, stm32, nrf52, renode (toolchain + emulator);
                                          FABWRIGHT_RUNTIME=docker builds the Docker images instead
                                          (micropython: firmware downloads; esp-idf / platformio: Docker images)
  build [--force]
  run --ms 5000 [--reset]                 simulate; prints serial, pins, part states
  display <part> [--ms N] [--scale S]     run N ms, then show the screen as ASCII
     [--region x,y,w,h] [--save-as NAME]  crop (exact pixels) / save a golden frame for expect_display
  test [scenario] [--visual] [--out F]    run scenarios (exit 1 when any fails); --visual writes the
                                          filmstrip report (default .fabwright/visual-report.json) and
                                          PNGs of the screen at key checks (.fabwright/test-frames/)
  check                                   design rule check (exit 1 on errors)
  fidelity                                what to trust, what to test on hardware
  screenshot [out.png] [--ms N]           run N ms first, then render the canvas
     [--scenario ID [--at-step N]]        or: replay a scenario up to step N (default: its end), then render
     [--view device]                      the physical device in 3D (handheld, rover arena, arm) at --ms
  render-device --ms 2500,6000 [--out D]  Device view PNGs at virtual times (or --every 100 --until 8000
     [--press part@ms,...] [--camera track|chase|arena] [--size 1280x800]   for a video's frames)
  network [--since N]                     what a Wi-Fi device did (joins, DNS, HTTP, AI replies)
  export [dir]                            BOM, wiring table, firmware.hex
History
  steps | undo | redo | accept [step] | reject <step>
Agents
  skill print [--target skill|agents|guide|instructions]   print Fabwright's hardware guide for agents
  skill install [--project D] [--force]   write <project>/.claude/skills/fabwright-hardware/SKILL.md (Claude
                                          Code loads it in that folder), <project>/AGENTS.md (Codex and
                                          others) and <project>/CLAUDE.md (imports AGENTS.md); files you
                                          wrote yourself are kept unless --force
Real device: API access without keys in the firmware (docs/api-relay.md)
  relay init [--out D]                    write relay/ (Node server, Cloudflare Worker + wrangler.toml, README,
                                          FabwrightRelay.h) from fabwright.json network; no secret values in it
  relay serve [--port 8787] [--host H]    run the relay on this computer (reads the project's .env)
  relay token add <device> | revoke <device> | list
                                          one token per device: the raw one goes to .env DEVICE_TOKEN (for
                                          flashing), only its hash to RELAY_DEVICE_TOKENS (for the relay)
  relay device-header [--ca root.pem]     write fabwright_device.h (git-ignored) next to the sketch from .env:
                                          RELAY_URL, DEVICE_TOKEN, WIFI_SSID, WIFI_PASSWORD
Any tool
  call <tool> [json-args]                 e.g. fabwright call inject_fault '{"part":"oled1","kind":"i2c_nack"}'
  tools                                   list tools
Servers
  serve [--project D] [--port 7780] [--built] [--no-web] [--no-open] [--strict-port]
                                          one local server: the canvas (following the project live),
                                          ws /live, and MCP over HTTP at /mcp on the same session.
                                          pnpm start = fabwright serve (project: projects/playground)
  mcp [--project D]                       MCP server on stdio (for Claude Code, Codex…)
  mcp --attach http://localhost:7780      stdio MCP that drives a running serve (live canvas)
  replay <actions.jsonl> [--speed 2] [--actor mcp] [--client claude] [--session SID]
                                          play an action log back in the browser (filters: whose lines)
  record <actions.jsonl> <out.mp4> [--speed 2] [--size 1280x720] [--actor all]   record a replay to video (the agent's calls only unless --actor all)
  runner [--port 7781]                    local firmware build service (HTTP)

--project defaults to $FABWRIGHT_PROJECT, then the current folder.`;

const BASE = process.env.INIT_CWD ?? process.cwd();

interface Parsed {
  cmd: string;
  pos: string[];
  opts: Record<string, string | boolean | string[] | undefined>;
}

function parse(argv: string[]): Parsed {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    strict: false,
    options: {
      project: { type: "string", short: "p" },
      json: { type: "boolean" },
      template: { type: "string" },
      name: { type: "string" },
      overwrite: { type: "boolean" },
      category: { type: "string" },
      id: { type: "string" },
      x: { type: "string" },
      y: { type: "string" },
      rotation: { type: "string" },
      prop: { type: "string", multiple: true },
      why: { type: "string" },
      color: { type: "string" },
      from: { type: "string" },
      to: { type: "string" },
      force: { type: "boolean" },
      ms: { type: "string" },
      reset: { type: "boolean" },
      scale: { type: "string" },
      scenario: { type: "string" },
      "at-step": { type: "string" },
      region: { type: "string" },
      "save-as": { type: "string" },
      port: { type: "string" },
      speed: { type: "string" },
      size: { type: "string" },
      open: { type: "boolean" },
      "no-open": { type: "boolean" },
      "no-web": { type: "boolean" },
      "live-port": { type: "string" },
      attach: { type: "string" },
      built: { type: "boolean" },
      "strict-port": { type: "boolean" },
      actor: { type: "string" },
      client: { type: "string" },
      session: { type: "string" },
      chrome: { type: "string" },
      visual: { type: "boolean" },
      out: { type: "string" },
      ca: { type: "string" },
      host: { type: "string" },
      view: { type: "string" },
      press: { type: "string" },
      camera: { type: "string" },
      every: { type: "string" },
      until: { type: "string" },
      svg: { type: "string" },
      "no-svg": { type: "boolean" },
      since: { type: "string" },
      target: { type: "string" },
      help: { type: "boolean", short: "h" },
    },
  });
  const [cmd = "help", ...pos] = positionals;
  return { cmd, pos, opts: values as Parsed["opts"] };
}

class UsageError extends Error {}

function num(v: unknown, name: string): number | undefined {
  if (v === undefined) return undefined;
  const n = Number(v);
  if (!Number.isFinite(n)) throw new UsageError(`--${name} must be a number (got '${String(v)}')`);
  return n;
}

function need(v: string | undefined, what: string): string {
  if (!v) throw new UsageError(`missing ${what}. Run 'fabwright help' for usage.`);
  return v;
}

function projectDir(opts: Parsed["opts"]): string {
  return resolve(BASE, (opts.project as string | undefined) ?? process.env.FABWRIGHT_PROJECT ?? ".");
}

/** `pnpm start` in the Fabwright repo itself: use projects/playground, not the repo root, as the project. */
function serveDir(opts: Parsed["opts"]): string {
  if (opts.project || process.env.FABWRIGHT_PROJECT) return projectDir(opts);
  const repo = resolve(BASE);
  if (existsSync(resolve(repo, "pnpm-workspace.yaml")) && existsSync(resolve(repo, "apps/cli/bin/fabwright.mjs"))) return resolve(repo, "projects/playground");
  return projectDir(opts);
}

/**
 * Round 5 (decision 0003, C3): a folder served or opened over MCP with --project joins the Projects
 * gallery ($FABWRIGHT_HOME/projects.json). Scratch folders under the OS temp dir (tests) are left out.
 */
function rememberProject(dir: string, source: "serve" | "cli"): void {
  const rel = relative(resolve(tmpdir()), dir);
  if (!rel.startsWith("..") && rel !== dir) return;
  try {
    registerProject(dir, { source });
  } catch {
    // the gallery list is a convenience; never block a server over it
  }
}

function props(list: unknown): Record<string, string | number | boolean> | undefined {
  if (!Array.isArray(list) || !list.length) return undefined;
  const out: Record<string, string | number | boolean> = {};
  for (const kv of list as string[]) {
    const i = kv.indexOf("=");
    if (i <= 0) throw new UsageError(`--prop expects key=value (got '${kv}')`);
    const v = kv.slice(i + 1);
    out[kv.slice(0, i)] = v === "true" ? true : v === "false" ? false : v !== "" && Number.isFinite(Number(v)) ? Number(v) : v;
  }
  return out;
}

async function readStdin(): Promise<string> {
  if (process.stdin.isTTY) throw new UsageError("write needs the file content on stdin or --from <local file>");
  let s = "";
  for await (const chunk of process.stdin) s += chunk;
  return s;
}

/** Map a command line to (op, args). Returns undefined for commands handled elsewhere. */
async function toOp(p: Parsed): Promise<{ op: string; args: Record<string, unknown>; dir?: string; pre?: { op: string; args: Record<string, unknown> } } | undefined> {
  const o = p.opts;
  const why = o.why ? { why: o.why as string } : {};
  const ms = num(o.ms, "ms");
  switch (p.cmd) {
    case "new":
      return { op: "new_project", dir: resolve(BASE, need(p.pos[0], "the project folder (fabwright new <dir>)")), args: { template: o.template ?? "blank", ...(o.name ? { name: o.name } : {}), ...(o.overwrite ? { overwrite: true } : {}) } };
    case "status":
    case "project":
      return { op: "get_project", args: {} };
    case "parts":
      if (p.pos[0] === "search") p.pos.shift();
      return { op: "search_parts", args: { query: p.pos.join(" "), ...(o.category ? { category: o.category } : {}) } };
    case "part":
      return { op: "get_part", args: { type: need(p.pos[0], "the part type (fabwright part led)") } };
    case "place":
      return { op: "place_part", args: { type: need(p.pos[0], "the part type"), ...(o.id ? { id: o.id } : {}), ...(o.x !== undefined ? { x: num(o.x, "x") } : {}), ...(o.y !== undefined ? { y: num(o.y, "y") } : {}), ...(o.rotation !== undefined ? { rotation: num(o.rotation, "rotation") } : {}), ...(props(o.prop) ? { props: props(o.prop) } : {}), ...why } };
    case "move":
      return { op: "move_part", args: { id: need(p.pos[0], "the part id"), ...(o.x !== undefined ? { x: num(o.x, "x") } : {}), ...(o.y !== undefined ? { y: num(o.y, "y") } : {}), ...(o.rotation !== undefined ? { rotation: num(o.rotation, "rotation") } : {}), ...why } };
    case "remove":
    case "rm":
      return { op: "remove", args: { id: need(p.pos[0], "the part, wire or scenario id"), ...why } };
    case "connect":
      return { op: "connect", args: { from: need(p.pos[0], "the first pin (part.pin)"), to: need(p.pos[1], "the second pin (part.pin)"), ...(o.color ? { color: o.color } : {}), ...why } };
    case "disconnect":
      return { op: "disconnect", args: p.pos[0] ? { wire: p.pos[0], ...why } : { from: need(o.from as string, "a wire id or --from"), ...(o.to ? { to: o.to } : {}), ...why } };
    case "set":
      return { op: "set_part_property", args: { id: need(p.pos[0], "the part id"), prop: need(p.pos[1], "the property"), value: (() => { const v = need(p.pos[2], "the value"); return Number.isFinite(Number(v)) ? Number(v) : v === "true" ? true : v === "false" ? false : v; })(), ...why } };
    case "libs":
      return { op: "set_libraries", args: { libraries: p.pos, ...why } };
    case "firmware":
      return { op: "set_firmware", args: { language: need(p.pos[0], "the language (arduino, micropython, esp-idf, platformio)"), ...(o.firmware ? { firmware: o.firmware } : {}), ...(o.target ? { target: o.target } : {}), ...(o.env ? { env: o.env } : {}), ...(o.board ? { board: o.board } : {}), ...why } };
    case "write":
      return { op: "write_file", args: { path: need(p.pos[0], "the path (firmware/main.ino)"), content: o.from ? readFileSync(resolve(BASE, o.from as string), "utf8") : await readStdin(), ...why } };
    case "read":
      return { op: "read_file", args: { path: need(p.pos[0], "the path") } };
    case "files":
      return { op: "list_files", args: {} };
    // Agent-made parts (decision 0003, C4/C5).
    case "create-part":
    case "update-part": {
      const create = p.cmd === "create-part";
      const id = create ? undefined : need(p.pos[0], "the part id");
      const file = create ? need(p.pos[0], "the part.json file") : p.pos[1];
      let part: unknown;
      if (file) {
        try {
          part = JSON.parse(readFileSync(resolve(BASE, file), "utf8"));
        } catch (err) {
          throw new UsageError(`could not read ${file} as JSON (${(err as Error).message})`);
        }
      }
      const svg = o["no-svg"] ? { svg: null } : o.svg ? { svg: readFileSync(resolve(BASE, o.svg as string), "utf8") } : {};
      return { op: create ? "create_part" : "update_part", args: { ...(id ? { id } : {}), ...(part ? { part } : {}), ...svg, ...why } };
    }
    case "project-parts":
      return { op: "list_project_parts", args: {} };
    case "build":
      return { op: "build", args: { ...(o.force ? { force: true } : {}) } };
    case "run":
      return { op: "run", args: { ms: ms ?? 1000, ...(o.reset ? { reset: true } : {}) } };
    case "display":
      return { op: "read_display", args: { part: need(p.pos[0], "the display part id"), ...(o.scale ? { scale: num(o.scale, "scale") } : {}), ...(o.region ? { region: String(o.region).split(",").map((v) => num(v.trim(), "region")) } : {}), ...(o["save-as"] ? { save_as: o["save-as"] } : {}) }, pre: { op: "run", args: { ms: ms ?? 1000 } } };
    case "test":
      return { op: "run_tests", args: { ...(p.pos[0] ? { name: p.pos[0] } : {}), ...(o.visual ? { images: true } : {}) } };
    case "network":
      return { op: "read_network_log", args: { ...(o.since ? { since: num(o.since, "since") } : {}) }, ...(ms ? { pre: { op: "run", args: { ms } } } : {}) };
    case "check":
      return { op: "check_design", args: {} };
    case "fidelity":
      return { op: "fidelity_report", args: {} };
    case "screenshot":
      if (o.scenario && ms) throw new UsageError("screenshot takes --ms or --scenario, not both (a scenario sets its own timing)");
      if (o.view === "device") return { op: "screenshot", args: { view: "device", path: resolve(BASE, p.pos[0] ?? "device.png"), ...(ms ? { ms } : {}) } };
      return { op: "screenshot", args: { path: resolve(BASE, p.pos[0] ?? "screenshot.png"), ...(o.scale ? { scale: num(o.scale, "scale") } : {}), ...(o.scenario ? { scenario: o.scenario } : {}), ...(o["at-step"] !== undefined ? { at_step: num(o["at-step"], "at-step") } : {}) }, ...(ms ? { pre: { op: "run", args: { ms } } } : {}) };
    case "export":
      return { op: "export", args: p.pos[0] ? { dir: resolve(BASE, p.pos[0]) } : {} };
    case "steps":
      return { op: "list_steps", args: {} };
    case "undo":
    case "redo":
      return { op: p.cmd, args: {} };
    case "accept":
      return { op: "accept_step", args: p.pos[0] ? { step: Number(p.pos[0]) } : {} };
    case "reject":
      return { op: "reject_step", args: { step: Number(need(p.pos[0], "the step id")) } };
    case "call": {
      const op = need(p.pos[0], "the tool name");
      let args: Record<string, unknown> = {};
      if (p.pos[1]) {
        try {
          args = JSON.parse(p.pos[1]);
        } catch (err) {
          throw new UsageError(`the arguments must be JSON, e.g. '{"part":"btn1","action":"press"}' (${(err as Error).message})`);
        }
      }
      return { op, args };
    }
    default: {
      // round 6 case: any tool by name, `fabwright design_case '{"shape":"pebble"}'` (same as fabwright call)
      const op = p.cmd.replace(/-/g, "_");
      if (!TOOLS.some((t) => t.name === op)) return undefined;
      let args: Record<string, unknown> = {};
      if (p.pos[0]) {
        try {
          args = JSON.parse(p.pos[0]);
        } catch (err) {
          throw new UsageError(`the arguments must be JSON, e.g. fabwright ${op} '{"shape":"pebble"}' (${(err as Error).message})`);
        }
      }
      return { op, args };
    }
  }
}

function print(result: unknown, json: boolean): void {
  if (json) {
    process.stdout.write(JSON.stringify(result) + "\n");
    return;
  }
  const r = result as Record<string, unknown>;
  const screen = typeof r?.screen === "string" ? r.screen : undefined;
  const content = typeof r?.content === "string" ? r.content : undefined;
  const rest = { ...r };
  delete rest.screen;
  if (content !== undefined) delete rest.content;
  process.stdout.write(stringify(rest, { lineWidth: 0 }));
  if (screen) process.stdout.write(screen + "\n");
  if (content !== undefined) process.stdout.write("---\n" + content + (content.endsWith("\n") ? "" : "\n"));
}

export async function main(argv = process.argv.slice(2)): Promise<number> {
  let p: Parsed;
  try {
    p = parse(argv);
  } catch (err) {
    process.stderr.write(`fabwright: ${(err as Error).message}\n`);
    return 2;
  }
  const json = !!p.opts.json;
  if (p.cmd === "help" || p.opts.help) {
    process.stdout.write(HELP + "\n");
    return 0;
  }
  if (p.cmd === "tools") {
    if (json) process.stdout.write(JSON.stringify(TOOLS.map((t) => ({ name: t.name, title: t.title, inputSchema: t.inputSchema }))) + "\n");
    else for (const t of TOOLS) process.stdout.write(`${t.name.padEnd(18)} ${t.title}\n`);
    return 0;
  }
  if (["mcp", "serve", "replay", "record", "runner"].includes(p.cmd)) {
    const servers = await import("./servers.ts");
    if ((p.cmd === "serve" || p.cmd === "mcp") && (p.opts.project || process.env.FABWRIGHT_PROJECT)) rememberProject(projectDir(p.opts), p.cmd === "serve" ? "serve" : "cli");
    return servers.runServerCommand(p.cmd, p.pos, p.opts, p.cmd === "serve" ? serveDir(p.opts) : projectDir(p.opts), BASE);
  }
  if (p.cmd === "render-device") return renderDeviceCommand(p);
  if (p.cmd === "setup") return setupCommand(p.pos[0]);
  if (p.cmd === "skill") return skillCommand(p);
  if (p.cmd === "relay") return relayCommand(p);
  let mapped: Awaited<ReturnType<typeof toOp>>;
  try {
    mapped = await toOp(p);
  } catch (err) {
    process.stderr.write(`fabwright: ${(err as Error).message}\n`);
    return 2;
  }
  if (!mapped) {
    process.stderr.write(`fabwright: unknown command '${p.cmd}'. Run 'fabwright help' (or 'fabwright call <tool> <json>' for any tool).\n`);
    return 2;
  }
  const session = new ProjectSession({ dir: mapped.dir ?? projectDir(p.opts), actor: "cli" });
  try {
    if (mapped.pre) await session.call(mapped.pre.op, mapped.pre.args);
    const result = await session.call(mapped.op, mapped.args);
    print(result, json);
    const r = result as Record<string, unknown>;
    if (mapped.op === "run_tests" && p.opts.visual && session.lastVisualReport) {
      const out = resolve(BASE, typeof p.opts.out === "string" ? p.opts.out : join(session.dir, ".fabwright", "visual-report.json"));
      mkdirSync(dirname(out), { recursive: true });
      writeFileSync(out, JSON.stringify(session.lastVisualReport));
      process.stderr.write(`visual report: ${out} (open the Tests panel in the web app, or serve it with fabwright serve)\n`);
    }
    if (mapped.op === "run_tests" && Number(r.failed) > 0) return 1;
    if (mapped.op === "check_design" && Number(r.errors) > 0) return 1;
    if (mapped.op === "build" && r.ok === false) return 1;
    return 0;
  } catch (err) {
    const msg = err instanceof FabwrightError ? err.message : (err as Error).message;
    if (json) process.stdout.write(JSON.stringify({ error: err instanceof FabwrightError ? err.toJSON() : { code: "internal", message: msg } }) + "\n");
    else process.stderr.write(`fabwright ${p.cmd}: ${msg}\n`);
    return 1;
  } finally {
    session.dispose();
  }
}

async function renderDeviceCommand(p: Parsed): Promise<number> {
  const o = p.opts;
  const dir = projectDir(o);
  const msList = typeof o.ms === "string" ? o.ms.split(",").filter(Boolean).map(Number) : [];
  const every = Number(o.every ?? 0);
  const until = Number(o.until ?? 0);
  if (!msList.length && !(every > 0 && until > 0)) {
    process.stderr.write("fabwright render-device: say when to render. Pass --ms 2500,6000 (virtual ms) or --every 100 --until 8000 for a video's frames.\n");
    return 2;
  }
  if (msList.some((n) => !Number.isFinite(n) || n < 0)) {
    process.stderr.write(`fabwright render-device: --ms ${o.ms} has a value that is not a number of milliseconds. Pass e.g. --ms 2500,6000.\n`);
    return 2;
  }
  const shots = msList.length ? msList : Array.from({ length: Math.floor(until / every) + 1 }, (_, i) => i * every);
  const presses = typeof o.press === "string" ? o.press.split(",").filter(Boolean).map((s) => ({ part: s.split("@")[0]!, at: Number(s.split("@")[1] ?? 0) })) : [];
  const [w, h] = (typeof o.size === "string" ? o.size : "1280x800").split("x").map(Number);
  const outDir = resolve(BASE, typeof o.out === "string" ? o.out : "device-shots");
  mkdirSync(outDir, { recursive: true });
  const { renderDevice } = await import("@fabwright/session");
  let n = 0;
  try {
    await renderDevice({
      dir,
      shots,
      presses,
      ...(w && h ? { width: w, height: h } : {}),
      ...(o.camera === "track" || o.camera === "chase" || o.camera === "arena" ? { camera: o.camera } : {}),
      onShot: (png, ms, i) => {
        writeFileSync(join(outDir, msList.length ? `device-${ms}ms.png` : `frame-${String(i).padStart(5, "0")}.png`), png);
        n++;
      },
    });
  } catch (err) {
    process.stderr.write(`fabwright render-device: ${(err as Error).message}\n`);
    return 1;
  }
  process.stdout.write(`${n} frame(s) in ${outDir}${every && !msList.length ? `; video: ffmpeg -framerate ${Math.round(1000 / every)} -i ${outDir}/frame-%05d.png -pix_fmt yuv420p device.mp4` : ""}\n`);
  return 0;
}

/**
 * Round 13: `fabwright relay init|serve|token|device-header`. The real device's API access: a relay the
 * person runs or deploys holds the keys; the device holds only a revocable token for that relay.
 */
async function relayCommand(p: Parsed): Promise<number> {
  const r = await import("@fabwright/session");
  const sub = p.pos[0];
  const dir = projectDir(p.opts);
  const say = (s: string) => process.stdout.write(`${s}\n`);
  let session: ProjectSession | undefined;
  try {
    session = new ProjectSession({ dir, actor: "cli" });
    const proj = { dir, project: session.project };
    if (sub === "init") {
      const out = typeof p.opts.out === "string" ? resolve(BASE, p.opts.out) : undefined;
      const w = r.writeRelayFolder(proj, out);
      const { spec } = r.relayConfigOf(proj);
      say(`relay written to ${w.dir} (${w.files.length} files). Hosts: ${spec.allow.map((a) => a.host).join(", ")}. Secrets by name: ${spec.secrets.join(", ") || "none"}.`);
      say(`Next: fabwright relay token add <device name>, then run it here (fabwright relay serve) or deploy it: cd ${relative(BASE, w.dir).startsWith("..") ? w.dir : relative(BASE, w.dir) || "."} && npx wrangler deploy (README.md has the steps).`);
      return 0;
    }
    if (sub === "token") {
      const action = p.pos[1];
      const name = p.pos[2];
      if (action === "add" && name) {
        const t = r.relayTokenAdd(proj, name);
        say(`device token for ${t.name}: ${t.token}`);
        say(`Saved in ${t.env}: DEVICE_TOKEN (this device's token, for flashing) and RELAY_DEVICE_TOKENS (hashes of ${t.devices.join(", ")}, for the relay).${t.ignored.length ? ` Added ${t.ignored.join(", ")} to .gitignore.` : ""}`);
        say("Next: give the relay the new RELAY_DEVICE_TOKENS (Cloudflare: npx wrangler secret put RELAY_DEVICE_TOKENS; fabwright relay serve reads .env), then fabwright relay device-header and flash this device.");
        return 0;
      }
      if (action === "revoke" && name) {
        const t = r.relayTokenRevoke(proj, name);
        say(`revoked ${t.name}; the relay still accepts: ${t.devices.join(", ") || "no device"}. Give the relay the new RELAY_DEVICE_TOKENS (npx wrangler secret put RELAY_DEVICE_TOKENS, or restart fabwright relay serve) for it to take effect.`);
        return 0;
      }
      if (action === "list") {
        const names = r.relayTokenList(proj);
        say(names.length ? names.join("\n") : "no device tokens yet: fabwright relay token add <device name>");
        return 0;
      }
      process.stderr.write(`fabwright relay token: say what to do. Why: '${action ?? ""}' needs add <device>, revoke <device> or list. Fix: fabwright relay token add star-1\n`);
      return 2;
    }
    if (sub === "device-header") {
      const h = r.writeDeviceHeader(proj, typeof p.opts.ca === "string" ? { ca: resolve(BASE, p.opts.ca) } : {});
      say(`wrote ${h.file} (relay ${h.relay_url}, Wi-Fi ${h.wifi_ssid}${h.added_header ? ", and FabwrightRelay.h next to it" : ""}). It holds this device's token and your Wi-Fi password: git-ignored, never compiled by Fabwright's own builds.`);
      say(`Build and flash from ${dirname(h.file)} with the Arduino IDE or arduino-cli compile --upload (Fabwright's factory pack firmware has no relay settings).`);
      return 0;
    }
    if (sub === "serve") {
      const port = typeof p.opts.port === "string" ? Number(p.opts.port) : 8787;
      const srv = await r.serveRelay(proj, { port, ...(typeof p.opts.host === "string" ? { host: p.opts.host } : {}) });
      process.stderr.write(`Fabwright relay for ${srv.spec.project} on ${srv.url} (hosts: ${srv.spec.allow.map((a) => a.host).join(", ")}; devices: ${srv.devices.join(", ") || "none yet: fabwright relay token add <device name>"})\n`);
      if (srv.missing_secrets.length) process.stderr.write(`Missing secrets: ${srv.missing_secrets.join(", ")} (requests that need them get 500 with the fix). Put NAME=value in ${join(dir, ".env")}.\n`);
      process.stderr.write("One JSON line per request below (no keys, tokens or query values). Ctrl+C stops it.\n");
      session.dispose();
      session = undefined;
      await new Promise<void>((done) => {
        const stop = () => void srv.close().then(done);
        process.once("SIGINT", stop);
        process.once("SIGTERM", stop);
      });
      return 0;
    }
    process.stderr.write(`fabwright relay: say what to do. Why: '${sub ?? ""}' is not init, serve, token or device-header. Fix: fabwright relay init (then see relay/README.md).\n`);
    return 2;
  } catch (err) {
    const msg = err instanceof FabwrightError ? err.message : (err as Error).message;
    process.stderr.write(`fabwright relay ${sub ?? ""}: ${msg}\n`);
    return 1;
  } finally {
    session?.dispose();
  }
}

/**
 * Round 12 skill: `fabwright skill print|install`. The same guide the MCP server sends, as files an agent
 * opened in the project folder reads by itself. Writes inside the project only, never the person's
 * global agent config.
 */
async function skillCommand(p: Parsed): Promise<number> {
  const sk = await import("@fabwright/agent-skill");
  const tools = TOOLS.map((t) => t.name);
  const sub = p.pos[0];
  if (sub === "print") {
    const target = typeof p.opts.target === "string" ? p.opts.target : "skill";
    const out: Record<string, () => string> = {
      skill: () => sk.renderSkillMd({ tools }),
      agents: () => sk.renderAgentsMd({ tools }),
      guide: () => sk.renderGuide({ tools }),
      instructions: () => sk.renderInstructionsBlock({ tools }),
    };
    const fn = out[target];
    if (!fn) {
      process.stderr.write(`fabwright skill print: no target '${target}'. Why: the guide prints as ${Object.keys(out).join(", ")}. Fix: fabwright skill print --target skill\n`);
      return 2;
    }
    process.stdout.write(fn());
    return 0;
  }
  if (sub === "install") {
    const dir = projectDir(p.opts);
    let name: string | undefined;
    try {
      name = (JSON.parse(readFileSync(join(dir, "fabwright.json"), "utf8")) as { name?: string }).name;
    } catch {
      name = undefined;
    }
    try {
      mkdirSync(dir, { recursive: true });
      const r = sk.installProjectFiles(dir, { tools, ...(name ? { projectName: name } : {}), force: !!p.opts.force });
      if (p.opts.json) process.stdout.write(JSON.stringify(r) + "\n");
      else for (const f of r.files) process.stdout.write(`${f.action.padEnd(9)} ${join(dir, f.path)}${f.why ? `\n          ${f.why}` : ""}\n`);
      return 0;
    } catch (err) {
      process.stderr.write(`fabwright skill install: could not write the agent files in ${dir}. Why: ${(err as Error).message}. Fix: check the folder exists and is writable, or pass --project <dir>.\n`);
      return 1;
    }
  }
  process.stderr.write(`fabwright skill: say what to do. Why: '${sub ?? ""}' is not print or install. Fix: fabwright skill print, or fabwright skill install --project <dir>.\n`);
  return 2;
}

/**
 * `fabwright setup`: install what builds and emulators need, with progress, so the first Build & Run is
 * fast. Round 11: board families install natively (~/.fabwright: arduino-cli + pinned cores and
 * libraries, Fabwright's patched QEMU, Renode), so a Mac needs no Docker; FABWRIGHT_RUNTIME=docker keeps
 * the round 10 behaviour (build the Docker images). Languages: MicroPython firmware (downloaded,
 * sha256 checked) or the toolchain Docker image (built from toolchains/<dir>).
 */
async function setupCommand(what: string | undefined): Promise<number> {
  const runner = await import("@fabwright/runner");
  const log = (l: string) => process.stderr.write(l + "\n");
  const list = () => {
    process.stdout.write(`${runner.runtimeSummary()}\n\nNative installs (fabwright setup <family>, or fabwright setup for all):\n`);
    for (const c of runner.nativeStatus()) process.stdout.write(`  ${c.installed ? "installed " : "missing   "} ${c.id.padEnd(10)} ${c.label}\n`);
    process.stdout.write(`\nFamilies: ${Object.entries(runner.SETUP_TARGETS).map(([k, v]) => `${k} (${v.label})`).join(", ")}\n`);
    process.stdout.write("\nLanguages and their support per chip (docs/firmware-languages.md):\n");
    for (const lang of Object.values(runner.LANGUAGES)) {
      const ok = Object.entries(lang.chips).filter(([, s]) => s.status === "verified").map(([c]) => c);
      process.stdout.write(`  ${lang.id.padEnd(12)} ${lang.label.padEnd(16)} verified on: ${ok.join(", ") || "none yet"}\n`);
    }
  };
  const report = (steps: Awaited<ReturnType<typeof runner.setupNative>>) => {
    for (const s of steps) process.stdout.write(`${s.what}: ${s.skipped ? "already installed" : `installed in ${(s.ms / 1000).toFixed(0)} s`}${s.bytes ? `, ${(s.bytes / 1e9).toFixed(2)} GB on disk` : ""}\n`);
  };
  const docker = runner.runtimeSetting() === "docker";
  try {
    switch (what) {
      case "list":
        list();
        return 0;
      case "micropython":
        for (const fw of runner.MICROPYTHON_FIRMWARE) {
          await runner.microPythonFirmwareBytes(fw, log);
          process.stdout.write(`MicroPython ${fw.version} ${fw.id} (${fw.chip}): ready${fw.verified ? "" : " (not verified in Fabwright: " + (fw.note ?? "") + ")"}\n`);
        }
        return 0;
      case "esp-idf":
        await runner.ensureToolchainImage(runner.ESP_IDF_IMAGE, log);
        process.stdout.write(`${runner.ESP_IDF_IMAGE.image}: ready\n`);
        return 0;
      case "platformio":
        await runner.ensureToolchainImage(runner.PLATFORMIO_IMAGE, log);
        process.stdout.write(`${runner.PLATFORMIO_IMAGE.image}: ready\n`);
        return 0;
    }
    if (docker && (what === "esp32" || what === "renode" || what === "stm32" || what === "nrf52")) {
      // FABWRIGHT_RUNTIME=docker: the round 10 path, Docker images.
      await runner.ensureDocker();
      if (what === "esp32") {
        await runner.ensureImage(log, runner.ESP32_IMAGE);
        process.stdout.write(`${runner.ESP32_IMAGE} (ESP32 / S3 / C3 builds): ready\n`);
        await runner.ensureEmulatorImage("qemu-esp", log);
        process.stdout.write(`${runner.EMULATORS["qemu-esp"].image} (Espressif QEMU + Fabwright bridge): ready\n`);
        return 0;
      }
      for (const image of [runner.STM32_IMAGE, runner.MBED_NANO_IMAGE, runner.NRF52_IMAGE]) {
        await runner.ensureImage(log, image);
        process.stdout.write(`${image}: ready\n`);
      }
      await runner.ensureEmulatorImage("renode", log);
      process.stdout.write(`${runner.EMULATORS.renode.image} (Renode 1.17.0 + Fabwright bridge): ready\n`);
      return 0;
    }
    const target = what === undefined || what === "all" ? "all" : runner.setupTargetOf(what);
    if (!target) {
      process.stderr.write(`fabwright setup: no toolchain called '${what}'. Why: Fabwright knows the board families ${Object.keys(runner.SETUP_TARGETS).join(", ")} (or all) and the languages micropython, esp-idf and platformio (rust and zephyr are planned). Fix: fabwright setup list.\n`);
      return 2;
    }
    log(runner.runtimeSummary());
    report(await runner.setupNative(target, log));
    return 0;
  } catch (err) {
    process.stderr.write(`fabwright setup ${what ?? "all"}: ${(err as Error).message}\n`);
    return 1;
  }
}
