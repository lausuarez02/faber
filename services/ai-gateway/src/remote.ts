// A live provider that asks a running gateway server over HTTP (the browser's live mode: the web
// app cannot run the claude CLI, so it calls `jumper-ai-gateway` on localhost, which can).
import { sanitizeReply, type PetReply, type PetRequest } from "./protocol.ts";
import type { LiveProvider } from "./petAi.ts";

export function remoteProvider(baseUrl = "http://127.0.0.1:8787", label = "AI gateway"): LiveProvider {
  return {
    id: "remote",
    label,
    async ask(req: PetRequest): Promise<PetReply> {
      const q = new URLSearchParams({ a: req.action, f: String(req.food), j: String(req.joy), e: String(req.energy), n: req.name });
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 20_000);
      try {
        const res = await fetch(`${baseUrl}/v1/pet?${q}`, { signal: ctrl.signal });
        const body = await res.text();
        if (!res.ok) throw new Error(`gateway answered ${res.status}: ${body.slice(0, 80)}`);
        return sanitizeReply(body, req);
      } catch (e) {
        const msg = (e as Error).name === "AbortError" ? "timed out after 20 s" : (e as Error).message;
        throw new Error(`cannot reach the AI gateway at ${baseUrl} (${msg}). Start it with: node services/ai-gateway/bin/ai-gateway.mjs`);
      } finally {
        clearTimeout(timer);
      }
    },
  };
}
