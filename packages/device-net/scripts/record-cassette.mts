// Record real HTTP(S) exchanges into a cassette, the way a device in internet mode with
// network.record would, so tests can replay them offline:
//   pnpm exec tsx packages/device-net/scripts/record-cassette.mts <cassette.json> <url> [url...]
// Each URL's host is allowed for this run only; the cassette is redacted like any other.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DeviceNet, parseNetworkConfig, probeRequest, SandboxCA } from "../src/index.ts";

const [file, ...urls] = process.argv.slice(2);
if (!file || !urls.length) {
  console.error("usage: record-cassette.mts <cassette.json> <url> [url...]");
  process.exit(2);
}
const hosts = [...new Set(urls.map((u) => new URL(u).hostname))];
const ca = await SandboxCA.open(join(mkdtempSync(join(tmpdir(), "jumper-rec-")), "ca"));
const dn = new DeviceNet({ config: parseNetworkConfig({ mode: "internet", record: true, allow: hosts.map((host) => ({ host })) }), ca, cassetteFile: file });
for (const url of urls) {
  const r = await probeRequest(dn, { url });
  console.log(`${url} → ${r.ok ? `${r.status}, ${r.bytes} B, ${r.ms} ms` : `${r.error} (${r.why ?? ""})`}`);
}
dn.close();
console.log(`wrote ${file}`);
