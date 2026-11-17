// Round 10 (network): the project's device network for a session. One DeviceNetHost (gateway +
// netstack in a worker thread, packages/device-net) per session, started on first use from
// faber.json "network", the mocks file (network/mocks.json) and the secrets named there (values
// from the environment or the project's git-ignored .env). Emulators plug their network card into
// framePort (QEMU: QemuEspBackend {network: {framePort, mac}}); the tools in tools/network.ts and
// the scenario steps read it.
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  ConfigError,
  DeviceNetHost,
  loadSecrets,
  parseMocks,
  parseNetworkConfig,
  resolveMocks,
  type Mock,
  type NetworkConfig,
} from "@faber/device-net";
import type { Project } from "@faber/project-format";
import { fail } from "./errors.ts";
import { userHomeDir } from "@faber/project-format/node";

export const DEFAULT_MOCKS_FILE = "network/mocks.json";

/** The per-machine sandbox CA folder (never in a project or an export). FABER_SANDBOX_CA_DIR overrides. */
export function sandboxCaDir(): string {
  return process.env.FABER_SANDBOX_CA_DIR ?? join(userHomeDir(homedir()), "sandbox-ca");
}

/** faber.json "network" as the gateway's config, with field / why / fix on a bad value. */
export function networkConfigOf(project: Project): NetworkConfig {
  try {
    return parseNetworkConfig(project.network ?? {});
  } catch (e) {
    if (e instanceof ConfigError) fail("bad-network", `faber.json ${e.field ?? "network"}: ${e.message}`, e.why, e.fix, { field: e.field });
    throw e;
  }
}

export function mocksFileOf(dir: string, cfg: NetworkConfig): string {
  return join(dir, cfg.mocks ?? DEFAULT_MOCKS_FILE);
}

export function loadMocksFile(file: string, projectDir?: string): Mock[] {
  if (!existsSync(file)) return [];
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(file, "utf8"));
  } catch (e) {
    fail("bad-mocks", `${file} is not valid JSON`, (e as Error).message, 'fix the JSON (it holds {"mocks": [...]}), or remove the file and use add_mock_api');
  }
  try {
    const list = parseMocks(raw);
    // round 14: OpenAPI mocks read their spec file (relative to the project folder)
    return projectDir ? resolveMocks(list, projectDir, file) : list;
  } catch (e) {
    if (e instanceof ConfigError) fail("bad-mocks", `${file}: ${e.message}`, e.why, e.fix, { field: e.field });
    throw e;
  }
}

export interface SecretStatus {
  name: string;
  set: boolean;
  hosts: string[];
}

export class SessionDeviceNet {
  private host: DeviceNetHost | undefined;
  private starting: Promise<DeviceNetHost> | undefined;
  private key = "";

  constructor(private readonly dir: () => string, private readonly project: () => Project) {}

  get running(): DeviceNetHost | undefined {
    return this.host;
  }

  config(): NetworkConfig {
    return networkConfigOf(this.project());
  }

  mocksFile(): string {
    return mocksFileOf(this.dir(), this.config());
  }

  secrets(cfg = this.config()): { values: Map<string, string>; status: SecretStatus[] } {
    const { values } = loadSecrets(cfg.secrets, { envFile: join(this.dir(), ".env") });
    return { values, status: cfg.secrets.map((name) => ({ name, set: values.has(name), hosts: cfg.allow.filter((a) => a.secrets?.includes(name)).map((a) => a.host) })) };
  }

  /** The running network, started (or restarted when the secrets or the cassette changed) on demand. */
  async ensure(): Promise<DeviceNetHost> {
    const cfg = this.config();
    const { values } = this.secrets(cfg);
    const key = JSON.stringify([cfg.secrets, [...values.values()].map((v) => v.length), cfg.cassette ?? "", cfg.record ?? false, this.dir()]);
    if (this.host && key === this.key) {
      if (JSON.stringify(this.host.config) !== JSON.stringify(cfg)) this.host.setConfig(cfg);
      return this.host;
    }
    if (this.starting) return this.starting;
    await this.close();
    this.key = key;
    this.starting = DeviceNetHost.start({
      config: cfg,
      mocks: loadMocksFile(this.mocksFile(), this.dir()),
      secrets: values,
      caDir: sandboxCaDir(),
      ...(cfg.cassette ? { cassetteFile: join(this.dir(), "network", "cassettes", `${cfg.cassette}.json`) } : {}),
    })
      .then((h) => (this.host = h))
      .catch((e: Error) => fail("network-start", "the device network could not start", e.message, "run pnpm install in the Faber repo (the network runs on tsx in a worker thread), then try again"))
      .finally(() => (this.starting = undefined));
    return this.starting;
  }

  async close(): Promise<void> {
    const h = this.host;
    this.host = undefined;
    this.key = "";
    if (h) await h.close();
  }
}
