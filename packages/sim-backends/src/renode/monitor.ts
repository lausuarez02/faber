// Renode's monitor over TCP (`renode --port <n>`): the same commands as the interactive console, one
// line at a time. Used for setup (load platform, ELF, start servers) and for things ExternalControl
// does not cover yet (setting a sensor property, reading a peripheral register).
import { Socket } from "node:net";

// Renode colours its output and draws the prompt as "(name) ".
// eslint-disable-next-line no-control-regex
const ANSI = /\x1b\[[0-9;]*[A-Za-z]/g;
const PROMPT = /\((?:monitor|[\w.-]+)\) $/;

export class RenodeMonitor {
  private readonly socket: Socket;
  private text = "";
  private raw: Buffer = Buffer.alloc(0);
  private waiter: (() => void) | undefined;
  private chain: Promise<unknown> = Promise.resolve();

  private constructor(socket: Socket) {
    this.socket = socket;
    socket.on("data", (d) => {
      this.raw = Buffer.concat([this.raw, d]);
      // Drop telnet IAC negotiation (0xFF cmd opt) and colours; decode the whole buffer so a colour
      // code or a UTF-8 character split across TCP chunks still parses.
      const bytes: number[] = [];
      for (let i = 0; i < this.raw.length; i++) {
        if (this.raw[i] === 0xff) i += 2;
        else bytes.push(this.raw[i]!);
      }
      this.text = Buffer.from(bytes).toString("utf8").replace(ANSI, "").replace(/\r/g, "");
      this.waiter?.();
    });
  }

  static async connect(port: number, host = "127.0.0.1", timeoutMs = 30_000): Promise<RenodeMonitor> {
    const deadline = Date.now() + timeoutMs;
    let last: unknown;
    while (Date.now() < deadline) {
      try {
        const socket = await new Promise<Socket>((resolve, reject) => {
          const s = new Socket();
          s.once("error", reject);
          s.connect(port, host, () => resolve(s));
        });
        const m = new RenodeMonitor(socket);
        const closed = new Promise<never>((_, rej) => socket.once("close", () => rej(new Error("connection closed before the prompt"))));
        try {
          await Promise.race([m.waitPrompt(3_000), closed]);
        } catch (e) {
          socket.destroy();
          throw e;
        }
        closed.catch(() => undefined);
        return m;
      } catch (e) {
        last = e;
        await new Promise((r) => setTimeout(r, 200));
      }
    }
    throw new Error(`Renode monitor did not answer on ${host}:${port} within ${timeoutMs} ms (${String(last)}). Fix: start Renode with --port ${port} and publish that port.`);
  }

  /** Run one monitor command and return its output (without the echo and the prompt). Throws on Renode's error lines. */
  exec(line: string, timeoutMs = 60_000): Promise<string> {
    const run = async () => {
      this.text = "";
      this.raw = Buffer.alloc(0);
      this.socket.write(line + "\n");
      await this.waitPrompt(timeoutMs);
      const out = this.text.replace(PROMPT, "").split("\n").filter((l) => l.trim() !== line.trim()).join("\n").trim();
      if (/^(There was an error|Error E\d+|No such command)/m.test(out)) throw new Error(`Renode rejected '${line}': ${out}`);
      return out;
    };
    const p = this.chain.then(run, run);
    this.chain = p.catch(() => undefined);
    return p;
  }

  close(): void {
    this.socket.destroy();
  }

  private waitPrompt(timeoutMs: number): Promise<void> {
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => {
        this.waiter = undefined;
        reject(new Error(`Renode monitor: no prompt after ${timeoutMs} ms; output so far: ${this.text.slice(-400)}`));
      }, timeoutMs);
      const check = () => {
        if (PROMPT.test(this.text)) {
          clearTimeout(t);
          this.waiter = undefined;
          resolve();
        }
      };
      this.waiter = check;
      check();
    });
  }
}
