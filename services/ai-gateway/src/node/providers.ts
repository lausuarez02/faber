// Live pet providers for Node, and the chain that picks one:
//   1. ANTHROPIC_API_KEY set     → the Anthropic Messages API (claude-haiku-5-5)
//   2. the `claude` CLI on PATH  → `claude -p --model claude-haiku-5-5` (the logged-in account)
//   3. otherwise                 → none: the gateway answers with the deterministic mock and says so
// Keys are read from the environment at call time and never logged or echoed.
import { spawn, spawnSync } from "node:child_process";
import { eventPrompt, personaPrompt, sanitizeReply, type PetReply, type PetRequest } from "../protocol.ts";
import type { LiveProvider } from "../petAi.ts";

export const PET_MODEL = "claude-haiku-5-5";
const TIMEOUT_MS = 25_000;

/** The Anthropic Messages API over fetch (the SDK is not a dependency of this repo). */
export function anthropicProvider(opts: { model?: string; apiKey?: () => string | undefined; timeoutMs?: number } = {}): LiveProvider {
  const model = opts.model ?? PET_MODEL;
  return {
    id: "anthropic-api",
    label: `Anthropic API (${model})`,
    model,
    async ask(req: PetRequest): Promise<PetReply> {
      const key = (opts.apiKey ?? (() => process.env.ANTHROPIC_API_KEY))();
      if (!key) throw new Error("ANTHROPIC_API_KEY is not set");
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), opts.timeoutMs ?? TIMEOUT_MS);
      try {
        const res = await fetch("https://api.anthropic.com/v1/messages", {
          method: "POST",
          signal: ctrl.signal,
          headers: { "content-type": "application/json", "x-api-key": key, "anthropic-version": "2023-06-01" },
          body: JSON.stringify({
            model,
            max_tokens: 1024,
            output_config: { effort: "low" },
            system: personaPrompt(req.name),
            messages: [{ role: "user", content: eventPrompt(req) }],
          }),
        });
        const json = (await res.json().catch(() => ({}))) as { content?: { type: string; text?: string }[]; stop_reason?: string; error?: { message?: string } };
        if (!res.ok) throw new Error(`Anthropic API ${res.status}: ${json.error?.message ?? "no message"}`);
        if (json.stop_reason === "refusal") throw new Error("the model declined this request (stop_reason refusal)");
        const text = (json.content ?? []).filter((b) => b.type === "text").map((b) => b.text ?? "").join("\n");
        return sanitizeReply(text, req);
      } catch (e) {
        if ((e as Error).name === "AbortError") throw new Error(`Anthropic API timed out after ${(opts.timeoutMs ?? TIMEOUT_MS) / 1000} s`);
        throw e;
      } finally {
        clearTimeout(timer);
      }
    },
  };
}

/** The logged-in `claude` CLI, one non-interactive call per question, no tools, no MCP, no session. */
export function claudeCliProvider(opts: { model?: string; bin?: string; timeoutMs?: number } = {}): LiveProvider {
  const model = opts.model ?? PET_MODEL;
  const bin = opts.bin ?? "claude";
  const timeoutMs = opts.timeoutMs ?? TIMEOUT_MS;
  return {
    id: "claude-cli",
    label: `Claude CLI (${model})`,
    model,
    ask(req: PetRequest): Promise<PetReply> {
      return new Promise((resolve, reject) => {
        const args = ["-p", "--model", model, "--output-format", "json", "--system-prompt", personaPrompt(req.name), "--tools", "", "--strict-mcp-config", "--no-session-persistence", "--disable-slash-commands", "--setting-sources", ""];
        const child = spawn(bin, args, { stdio: ["pipe", "pipe", "pipe"], env: { ...process.env, NO_COLOR: "1" } });
        let out = "";
        let err = "";
        const timer = setTimeout(() => {
          child.kill("SIGKILL");
          reject(new Error(`claude CLI timed out after ${timeoutMs / 1000} s`));
        }, timeoutMs);
        child.stdout.on("data", (d: Buffer) => (out += d.toString("utf8")));
        child.stderr.on("data", (d: Buffer) => (err += d.toString("utf8")));
        child.on("error", (e) => {
          clearTimeout(timer);
          reject(new Error(`cannot start '${bin}': ${e.message}. Install Claude Code and run 'claude' once to log in, or set ANTHROPIC_API_KEY`));
        });
        child.on("close", (code) => {
          clearTimeout(timer);
          let parsed: { result?: string; is_error?: boolean; subtype?: string } | undefined;
          try {
            parsed = JSON.parse(out) as typeof parsed;
          } catch {
            parsed = undefined;
          }
          if (code !== 0 || !parsed || parsed.is_error || typeof parsed.result !== "string") {
            const why = (parsed?.result ?? err ?? out).toString().trim().split("\n")[0]?.slice(0, 160) || `exit code ${code}`;
            return reject(new Error(`claude CLI failed: ${why}. Check that 'claude -p hi' works in a terminal (log in with 'claude')`));
          }
          resolve(sanitizeReply(parsed.result, req));
        });
        child.stdin.end(eventPrompt(req));
      });
    },
  };
}

function hasCommand(bin: string): boolean {
  try {
    const r = spawnSync(bin, ["--version"], { stdio: "ignore", timeout: 5000 });
    return r.status === 0;
  } catch {
    return false;
  }
}

export interface ProviderChoice {
  provider: LiveProvider | undefined;
  /** Why this one (for the server banner and the network view). */
  reason: string;
}

/**
 * The provider chain. `prefer` forces one ("anthropic-api", "claude-cli", "mock"); the env var
 * JUMPER_AI_PROVIDER does the same. Under tests (VITEST / CI set) nothing live is chosen.
 */
export function chooseProvider(opts: { prefer?: string; env?: NodeJS.ProcessEnv; claudeBin?: string } = {}): ProviderChoice {
  const env = opts.env ?? process.env;
  const prefer = (opts.prefer ?? env.JUMPER_AI_PROVIDER ?? "").toLowerCase();
  if (prefer === "mock") return { provider: undefined, reason: "mock forced (JUMPER_AI_PROVIDER=mock)" };
  if ((env.VITEST || env.CI) && !prefer) return { provider: undefined, reason: "tests / CI: the deterministic mock only" };
  if ((prefer === "" || prefer === "anthropic-api") && env.ANTHROPIC_API_KEY) {
    return { provider: anthropicProvider(), reason: "ANTHROPIC_API_KEY is set" };
  }
  if (prefer === "anthropic-api") return { provider: undefined, reason: "JUMPER_AI_PROVIDER=anthropic-api but ANTHROPIC_API_KEY is not set" };
  const bin = opts.claudeBin ?? env.JUMPER_CLAUDE_BIN ?? "claude";
  if (hasCommand(bin)) return { provider: claudeCliProvider({ bin }), reason: `'${bin}' CLI found (uses its logged-in account)` };
  return { provider: undefined, reason: "no ANTHROPIC_API_KEY and no claude CLI on PATH: mock only" };
}
