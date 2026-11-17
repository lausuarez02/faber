# @faber/ai-gateway

The sandbox network that simulated Wi-Fi parts (the ESP-01) join, and the pet AI behind
`http://ai.faber/v1/pet`. Also a real HTTP server, so the same firmware works on a real board.

| Entry | Runs in | What |
| --- | --- | --- |
| `src/index.ts` | Node and browser | `createSandboxNetwork()` (FaberNet, DNS, ai.faber, log, `wifi_drop`), `PetAi` (mock / live, rate limit, cache), the pet protocol, the deterministic mock, `remoteProvider()` (live through a running gateway) |
| `src/node/index.ts` | Node | `chooseProvider()`, `anthropicProvider()`, `claudeCliProvider()`, `startGatewayServer()` |
| `bin/ai-gateway.mjs` | Node | `node services/ai-gateway/bin/ai-gateway.mjs [--port 8787] [--host 0.0.0.0] [--provider anthropic-api|claude-cli|mock]`, or `--ask "a=talk&f=40&j=70&e=80"` for one reply |

## Protocol

`GET /v1/pet?a=<talk|feed|play|sleep|lonely|hello>&f=<food>&j=<joy>&e=<energy>&n=<name>[&m=<message>]` →
`HTTP/1.0 200`, body `<mood>|<text>` (mood: happy, hungry, sleepy, sad, excited; text <= 60
printable ASCII). 400 with `error|<what>; <fix>` for bad input, 429 `sleepy|Too many questions...`
when rate limited, 502/504 `sad|My thinking cloud is offline...` when the live model failed (the
network log has the reason).

`m` (optional, round 5) is what the person said, URL-encoded: cut to 60 printable ASCII characters
and given to the model as "Your owner says to you: …". The mock answers it with a canned line that
quotes it. In a simulation, `SandboxNet.say(text)` attaches a message to the next request that has
no `m` (the web app's talk box), and the network log notes it. `faber serve` starts this server
itself (`FABER_AI_GATEWAY_PORT`, default 8787, next free port; `FABER_AI_GATEWAY=off` to skip).

## Providers

1. `ANTHROPIC_API_KEY` → Anthropic Messages API, `claude-haiku-5-5`, effort low.
2. `claude` on PATH → `claude -p --model claude-haiku-5-5 --output-format json` (no tools, no MCP,
   no session), 25 s timeout.
3. Otherwise mock. Tests (`VITEST`/`CI` set) only get the mock unless `FABER_AI_PROVIDER` forces
   a provider. Keys are read at call time and never logged.

In a simulation the mock answers unless the host opens a live window (`liveAllowed`): the session
only does it in `run_live`, the web app only at <= 1x speed with Live on.

## Tests

`pnpm vitest run services/ai-gateway` (protocol, mock, network, provider chain, server, and the
examples/ai-pet scenarios through the session). `FABER_LIVE_AI=1` adds two live checks (one CLI
call, and the pet's TALK answered by Claude on the simulated screen).
