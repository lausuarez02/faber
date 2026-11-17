// A scripted stand-in for the patched QEMU, for unit tests of the bridge (no Docker needed).
// It speaks the bridge protocol like the real GPIO block: says hello, parks at 0, and on every
// "R <ns>" sends the scripted events up to that time (waiting for answers where QEMU would block),
// then parks with "T <ns>". Every line Fabwright sends is recorded with the virtual time it arrived at.
//
//   node fake-qemu.mjs <port> <script.json> <record.json>
//   script: { hello: "H fabwright-esp32-bridge 3 esp32c3.gpio sync=1 feat=...", events: [
//             { ns: 1000, line: "L 0 1 0 ..." },            // sent when the run reaches ns
//             { ns: 2000, line: "IS 3c w 7d0", answer: true }, // waits for A / D / Q
//             { ns: 3000, park: true } ] }                   // parks early ("T"), like a watched pin
import { createConnection } from "node:net";
import { readFileSync, writeFileSync } from "node:fs";

const [port, scriptPath, recordPath] = process.argv.slice(2);
const script = JSON.parse(readFileSync(scriptPath, "utf8"));
const events = [...script.events].sort((a, b) => a.ns - b.ns);
const record = [];
let now = 0;
let target = 0;
let buf = "";
const lines = [];
let waiters = [];

const sock = createConnection({ host: "127.0.0.1", port: Number(port) }, () => {
  sock.setNoDelay(true);
  sock.write(`${script.hello}\n`);
  main().catch((e) => {
    record.push({ t: now, line: `ERROR ${e.message}` });
    finish();
  });
});
sock.setEncoding("latin1");
sock.on("data", (d) => {
  buf += d;
  let i;
  while ((i = buf.indexOf("\n")) >= 0) {
    const l = buf.slice(0, i);
    buf = buf.slice(i + 1);
    lines.push(l);
  }
  const w = waiters;
  waiters = [];
  for (const f of w) f();
});
sock.on("close", finish);
process.on("SIGTERM", finish);
sock.on("error", finish);

let done = false;
function finish() {
  if (done) return;
  done = true;
  writeFileSync(recordPath, JSON.stringify(record));
  process.exit(0);
}

async function nextLine() {
  while (lines.length === 0) await new Promise((r) => waiters.push(r));
  return lines.shift();
}

/** Reads lines until one of `kinds` arrives; records everything. "R" always retargets. */
async function waitFor(kinds) {
  for (;;) {
    const l = await nextLine();
    record.push({ t: now, line: l });
    if (l.startsWith("R ")) target = parseInt(l.slice(2), 16);
    if (kinds.includes(l[0])) return l;
  }
}

async function park(at) {
  now = at;
  sock.write(`T ${at.toString(16)}\n`);
  await waitFor(["R"]);
}

async function main() {
  await park(0);
  for (;;) {
    while (events.length && events[0].ns <= target) {
      const ev = events.shift();
      now = ev.ns;
      if (ev.park) {
        await park(ev.ns);
        continue;
      }
      sock.write(`${ev.line}\n`);
      if (ev.answer) await waitFor(["A", "D", "Q"]);
    }
    await park(target);
  }
}
