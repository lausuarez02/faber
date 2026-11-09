import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { parseArgs } from "node:util";
import { stringify } from "yaml";
import { JumperError, ProjectSession, registerProject, TOOLS } from "@jumper/session";

/**
 * `jumper`: the same operations as the MCP tools, as subcommands. Human output is YAML; --json prints
 * the exact tool result as one JSON line. Exit code 0 = ok, 1 = the operation failed (or tests failed /
 * design errors), 2 = bad command line.
 */

const HELP = `jumper: hardware sandbox CLI (same operations as the MCP server)

Usage: jumper <command> [args] [--project <dir>] [--json]

Project
  new <dir> [--template blank|uno|nano|blink] [--name N] [--overwrite]
  status                                  project summary (get_project)
  parts [query] [--category C]            search the catalog
  part <type>                             pins, wiring, example code
  place <type> [--id I] [--x X --y Y] [--rotation R] [--prop k=v]... [--why W]
  move <id> [--x X] [--y Y] [--rotation R]
  remove <id>                             part, wire or test scenario
  connect <from> <to> [--color C]         e.g. jumper connect uno.D13 r1.1
  disconnect <wire> | --from P [--to P]
  set <id> <prop> <value>                 set_part_property
  libs <name>...                          set_libraries
  write <path> [--from local-file]        write_file (content from --from or stdin)
  read <path>                             read_file
  files                                   list_files
Firmware and simulation
  build [--force]
  run --ms 5000 [--reset]                 simulate; prints serial, pins, part states
  display <part> [--ms N] [--scale S]     run N ms, then show the screen as ASCII
     [--region x,y,w,h] [--save-as NAME]  crop (exact pixels) / save a golden frame for expect_display
  test [scenario] [--visual] [--out F]    run scenarios (exit 1 when any fails); --visual writes the
                                          filmstrip report (default .jumper/visual-report.json) and
                                          PNGs of the screen at key checks (.jumper/test-frames/)
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
Any tool
  call <tool> [json-args]                 e.g. jumper call inject_fault '{"part":"oled1","kind":"i2c_nack"}'
  tools                                   list tools
Servers
  serve [--project D] [--port 7780] [--built] [--no-web] [--no-open] [--strict-port]
                                          one local server: the canvas (following the project live),
                                          ws /live, and MCP over HTTP at /mcp on the same session.
                                          pnpm start = jumper serve (project: projects/playground)
  mcp [--project D]                       MCP server on stdio (for Claude Code, Codex…)
  mcp --attach http://localhost:7780      stdio MCP that drives a running serve (live canvas)
  replay <actions.jsonl> [--speed 2] [--actor mcp] [--client claude] [--session SID]
                                          play an action log back in the browser (filters: whose lines)
  record <actions.jsonl> <out.mp4> [--speed 2] [--size 1280x720] [--actor mcp]   record a replay to video
  runner [--port 7781]                    local firmware build service (HTTP)

--project defaults to $JUMPER_PROJECT, then the current folder.`;

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
      view: { type: "string" },
      press: { type: "string" },
      camera: { type: "string" },
      every: { type: "string" },
      until: { type: "string" },
      since: { type: "string" },
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
  if (!v) throw new UsageError(`missing ${what}. Run 'jumper help' for usage.`);
  return v;
}

function projectDir(opts: Parsed["opts"]): string {
  return resolve(BASE, (opts.project as string | undefined) ?? process.env.JUMPER_PROJECT ?? ".");
}

/** `pnpm start` in the Jumper repo itself: use projects/playground, not the repo root, as the project. */
function serveDir(opts: Parsed["opts"]): string {
  if (opts.project || process.env.JUMPER_PROJECT) return projectDir(opts);
  const repo = resolve(BASE);
  if (existsSync(resolve(repo, "pnpm-workspace.yaml")) && existsSync(resolve(repo, "apps/cli/bin/jumper.mjs"))) return resolve(repo, "projects/playground");
  return projectDir(opts);
}

/**
 * Round 5 (decision 0003, C3): a folder served or opened over MCP with --project joins the Projects
 * gallery ($JUMPER_HOME/projects.json). Scratch folders under the OS temp dir (tests) are left out.
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
      return { op: "new_project", dir: resolve(BASE, need(p.pos[0], "the project folder (jumper new <dir>)")), args: { template: o.template ?? "blank", ...(o.name ? { name: o.name } : {}), ...(o.overwrite ? { overwrite: true } : {}) } };
    case "status":
    case "project":
      return { op: "get_project", args: {} };
    case "parts":
      if (p.pos[0] === "search") p.pos.shift();
      return { op: "search_parts", args: { query: p.pos.join(" "), ...(o.category ? { category: o.category } : {}) } };
    case "part":
      return { op: "get_part", args: { type: need(p.pos[0], "the part type (jumper part led)") } };
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
    case "write":
      return { op: "write_file", args: { path: need(p.pos[0], "the path (firmware/main.ino)"), content: o.from ? readFileSync(resolve(BASE, o.from as string), "utf8") : await readStdin(), ...why } };
    case "read":
      return { op: "read_file", args: { path: need(p.pos[0], "the path") } };
    case "files":
      return { op: "list_files", args: {} };
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
    default:
      return undefined;
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
    process.stderr.write(`jumper: ${(err as Error).message}\n`);
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
    if ((p.cmd === "serve" || p.cmd === "mcp") && (p.opts.project || process.env.JUMPER_PROJECT)) rememberProject(projectDir(p.opts), p.cmd === "serve" ? "serve" : "cli");
    return servers.runServerCommand(p.cmd, p.pos, p.opts, p.cmd === "serve" ? serveDir(p.opts) : projectDir(p.opts), BASE);
  }
  if (p.cmd === "render-device") return renderDeviceCommand(p);
  let mapped: Awaited<ReturnType<typeof toOp>>;
  try {
    mapped = await toOp(p);
  } catch (err) {
    process.stderr.write(`jumper: ${(err as Error).message}\n`);
    return 2;
  }
  if (!mapped) {
    process.stderr.write(`jumper: unknown command '${p.cmd}'. Run 'jumper help' (or 'jumper call <tool> <json>' for any tool).\n`);
    return 2;
  }
  const session = new ProjectSession({ dir: mapped.dir ?? projectDir(p.opts), actor: "cli" });
  try {
    if (mapped.pre) await session.call(mapped.pre.op, mapped.pre.args);
    const result = await session.call(mapped.op, mapped.args);
    print(result, json);
    const r = result as Record<string, unknown>;
    if (mapped.op === "run_tests" && p.opts.visual && session.lastVisualReport) {
      const out = resolve(BASE, typeof p.opts.out === "string" ? p.opts.out : join(session.dir, ".jumper", "visual-report.json"));
      mkdirSync(dirname(out), { recursive: true });
      writeFileSync(out, JSON.stringify(session.lastVisualReport));
      process.stderr.write(`visual report: ${out} (open the Tests panel in the web app, or serve it with jumper serve)\n`);
    }
    if (mapped.op === "run_tests" && Number(r.failed) > 0) return 1;
    if (mapped.op === "check_design" && Number(r.errors) > 0) return 1;
    if (mapped.op === "build" && r.ok === false) return 1;
    return 0;
  } catch (err) {
    const msg = err instanceof JumperError ? err.message : (err as Error).message;
    if (json) process.stdout.write(JSON.stringify({ error: err instanceof JumperError ? err.toJSON() : { code: "internal", message: msg } }) + "\n");
    else process.stderr.write(`jumper ${p.cmd}: ${msg}\n`);
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
    process.stderr.write("jumper render-device: say when to render. Pass --ms 2500,6000 (virtual ms) or --every 100 --until 8000 for a video's frames.\n");
    return 2;
  }
  if (msList.some((n) => !Number.isFinite(n) || n < 0)) {
    process.stderr.write(`jumper render-device: --ms ${o.ms} has a value that is not a number of milliseconds. Pass e.g. --ms 2500,6000.\n`);
    return 2;
  }
  const shots = msList.length ? msList : Array.from({ length: Math.floor(until / every) + 1 }, (_, i) => i * every);
  const presses = typeof o.press === "string" ? o.press.split(",").filter(Boolean).map((s) => ({ part: s.split("@")[0]!, at: Number(s.split("@")[1] ?? 0) })) : [];
  const [w, h] = (typeof o.size === "string" ? o.size : "1280x800").split("x").map(Number);
  const outDir = resolve(BASE, typeof o.out === "string" ? o.out : "device-shots");
  mkdirSync(outDir, { recursive: true });
  const { renderDevice } = await import("@jumper/session");
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
    process.stderr.write(`jumper render-device: ${(err as Error).message}\n`);
    return 1;
  }
  process.stdout.write(`${n} frame(s) in ${outDir}${every && !msList.length ? `; video: ffmpeg -framerate ${Math.round(1000 / every)} -i ${outDir}/frame-%05d.png -pix_fmt yuv420p device.mp4` : ""}\n`);
  return 0;
}
