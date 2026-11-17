import { createServer, type Server } from "node:http";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, normalize } from "node:path";
import { tmpdir } from "node:os";
import { buildFirmware, type BuildRequest } from "./build.ts";
import { DEFAULT_PORT, RUNNER_IMAGE } from "./config.ts";
import { RunnerError } from "./docker.ts";

/**
 * Local build service. Listens on 127.0.0.1 only.
 *
 *   GET  /health                       → { ok, image }
 *   POST /build  { sketchDir, main?, fqbn, libraries?, cache? }        build a folder on this machine
 *   POST /build  { files: { "main.ino": "..." }, main?, fqbn, libraries? }   build sources sent inline
 *   POST /build  { language: "micropython", chip: "rp2040", files: { "main.py": "..." } }   other languages
 *                (language, chip, board, micropythonFirmware, target, env; see docs/firmware-languages.md)
 *
 * Response: BuildResult JSON (ok:false + diagnostics for compile errors), or
 * { ok:false, error:{ code, message } } with HTTP 503 for environment problems (Docker not running…).
 */
export function startRunnerServer(port = DEFAULT_PORT, host = "127.0.0.1"): Promise<Server> {
  const server = createServer(async (req, res) => {
    const send = (status: number, body: unknown) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
    };
    try {
      if (req.method === "GET" && req.url === "/health") return send(200, { ok: true, image: RUNNER_IMAGE });
      if (req.method !== "POST" || req.url !== "/build") {
        return send(404, { ok: false, error: { code: "not-found", message: `No route ${req.method} ${req.url}. Use GET /health or POST /build.` } });
      }
      let raw = "";
      for await (const chunk of req) raw += chunk;
      let body: Partial<BuildRequest> & { files?: Record<string, string> };
      try {
        body = JSON.parse(raw);
      } catch {
        return send(400, { ok: false, error: { code: "bad-json", message: "Request body is not JSON. Send { fqbn, sketchDir } or { fqbn, files }." } });
      }
      if (!body.fqbn && !body.language) return send(400, { ok: false, error: { code: "missing-fqbn", message: 'Missing "fqbn". Fix: send e.g. { "fqbn": "arduino:avr:uno", ... }.' } });
      let tmp: string | undefined;
      let sketchDir = body.sketchDir;
      if (body.files) {
        tmp = mkdtempSync(join(tmpdir(), "fabwright-build-"));
        for (const [name, content] of Object.entries(body.files)) {
          const rel = normalize(name);
          if (rel.startsWith("..") || rel.startsWith("/")) return send(400, { ok: false, error: { code: "bad-path", message: `File name '${name}' escapes the sketch folder. Use plain relative names like "main.ino" or "src/util.h".` } });
          mkdirSync(dirname(join(tmp, rel)), { recursive: true });
          writeFileSync(join(tmp, rel), content);
        }
        sketchDir = tmp;
      }
      if (!sketchDir) return send(400, { ok: false, error: { code: "missing-sources", message: 'Send "sketchDir" (absolute path) or "files" ({ "main.ino": "..." }).' } });
      try {
        const pass = { language: body.language, chip: body.chip, board: body.board, micropythonFirmware: body.micropythonFirmware, target: body.target, env: body.env, fqbn: body.fqbn };
        const defined = Object.fromEntries(Object.entries(pass).filter(([, v]) => typeof v === "string")) as Partial<BuildRequest>;
        const result = await buildFirmware({ sketchDir, ...defined, ...(body.main ? { main: body.main } : {}), ...(body.libraries ? { libraries: body.libraries } : {}), ...(body.cache === false ? { cache: false } : {}) });
        // Binary images (ESP flash, ELF) travel as base64 in JSON.
        const { binary, ...rest } = result;
        return send(200, binary ? { ...rest, binaryBase64: Buffer.from(binary).toString("base64") } : rest);
      } finally {
        if (tmp) rmSync(tmp, { recursive: true, force: true });
      }
    } catch (err) {
      if (err instanceof RunnerError) return send(503, { ok: false, error: { code: err.code, message: err.message } });
      return send(500, { ok: false, error: { code: "internal", message: (err as Error).message } });
    }
  });
  return new Promise((resolve, reject) => {
    server.once("error", (err: NodeJS.ErrnoException) =>
      reject(err.code === "EADDRINUSE" ? new RunnerError("port-in-use", `Port ${port} is already in use (another runner?). Fix: stop it, or pass --port <n>.`) : err),
    );
    server.listen(port, host, () => resolve(server));
  });
}
