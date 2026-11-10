// Browser-safe entry: the sandbox network, the pet protocol and the deterministic mock.
// Node-only providers (claude CLI, Anthropic API) and the HTTP server: "@jumper/ai-gateway/node".
export { createSandboxNetwork, SandboxNet } from "./network.ts";
export type { AccessPoint, NetLogEntry, HostHandler, HostResult, HostContext, SandboxNetworkOptions } from "./network.ts";
export { PetAi, PROVIDER_LABELS } from "./petAi.ts";
export type { LiveProvider, PetAnswer, PetResult, PetAiOptions, ProviderId } from "./petAi.ts";
export { MOODS, ACTIONS, MAX_TEXT, MAX_MESSAGE, cleanMessage, petQuery, parsePetQuery, moodFromStats, personaPrompt, eventPrompt, sanitizeReply, formatReply, PetRequestError } from "./protocol.ts";
export type { Mood, PetAction, PetRequest, PetReply } from "./protocol.ts";
export { mockReply, mockLatencyMs, hash32 } from "./mock.ts";
export { parseHttpRequest, httpResponse } from "./http.ts";
export type { HttpRequest, HttpParse } from "./http.ts";
export { remoteProvider } from "./remote.ts";
