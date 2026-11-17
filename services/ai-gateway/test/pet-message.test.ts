import { describe, expect, it } from "vitest";
import { createSandboxNetwork, eventPrompt, mockReply, parsePetQuery, petQuery, PetAi, type LiveProvider, type PetRequest } from "../src/index.ts";
import { startGatewayServer } from "../src/node/index.ts";

// Round 5 (decision 0003, C5): the person's message m= reaches the model.
const GET = (q: string) => `GET /v1/pet?${q} HTTP/1.0\r\nHost: ai.faber\r\n\r\n`;

describe("pet protocol: m= (what the person said)", () => {
  it("parses, cleans and caps the message at 60 characters", () => {
    expect(parsePetQuery("a=talk&m=what%20is%20your%20favorite%20food%3F").message).toBe("what is your favorite food?");
    expect(parsePetQuery("a=talk&m=hola+%C2%BFqu%C3%A9+tal%3F").message).toBe("hola qu tal?");
    expect(parsePetQuery(`a=talk&m=${"x".repeat(90)}`).message).toHaveLength(60);
    expect(parsePetQuery("a=talk&m=").message).toBeUndefined();
    expect(parsePetQuery("a=talk")).not.toHaveProperty("message");
  });

  it("the model's prompt carries it, and the query builder sends it", () => {
    const r = parsePetQuery("a=talk&f=40&j=70&e=80&m=do%20you%20like%20rain");
    expect(eventPrompt(r)).toContain('Your owner says to you: "do you like rain". Answer that, in character.');
    expect(eventPrompt(parsePetQuery("a=talk"))).not.toContain("says to you");
    expect(parsePetQuery(petQuery(r))).toEqual(r);
  });

  it("the mock shows the words arrived, deterministically, within the protocol", () => {
    const r = parsePetQuery("a=talk&f=50&j=50&e=50&m=what%20is%20your%20favorite%20food%3F");
    const a = mockReply(r, 0);
    expect(a).toEqual(mockReply(r, 0));
    expect(a.text).toMatch(/"what is your favorit\.\."/);
    expect(a.text.length).toBeLessThanOrEqual(60);
    expect(a.text).toMatch(/^[ -~]+$/);
  });

  it("a live provider gets the message; answers to different messages are not shared by the cache", async () => {
    const seen: PetRequest[] = [];
    const live: LiveProvider = { id: "claude-cli", label: "fake", ask: async (req) => (seen.push(req), { mood: "happy", text: `re: ${req.message ?? "-"}` }) };
    const ai = new PetAi({ mode: "live", live, minIntervalMs: 0, wallNow: () => 0 });
    const one = ai.answer(parsePetQuery("a=talk&m=hi"));
    const two = ai.answer(parsePetQuery("a=talk&m=bye"));
    if (one.kind !== "later" || two.kind !== "later") throw new Error("expected live calls");
    expect((await one.promise).body).toBe("happy|re: hi");
    expect((await two.promise).body).toBe("happy|re: bye");
    expect(seen.map((r) => r.message)).toEqual(["hi", "bye"]);
  });

  it("say(): the canvas text box rides on the pet's next request, once, and the log says so", () => {
    const net = createSandboxNetwork();
    expect(net.say("  what is   your name?  ")).toBe("what is your name?");
    expect(net.waitingMessage).toBe("what is your name?");
    net.join("FaberNet", "", 100, "esp");
    const ask = (t: number) => {
      const s = net.open({ host: "ai.faber", ip: "10.0.0.2", port: 80, tls: false, tMs: t, partId: "esp" });
      if ("error" in s) throw new Error("refused");
      s.write(GET("a=talk&f=50&j=50&e=50"), t);
      const http = [...net.log].reverse().find((e) => e.kind === "http")!;
      if (http.kind !== "http") throw new Error();
      return { http, data: s.read(t + http.latencyMs!).data };
    };
    const first = ask(200);
    expect(first.data).toMatch(/"what is your name\?"/);
    expect(first.http.note).toMatch(/with the person's message "what is your name\?"/);
    expect(net.waitingMessage).toBeUndefined();
    const second = ask(2000);
    expect(second.data).not.toMatch(/what is your name/);
  });

  it("the HTTP gateway passes m= through", async () => {
    const { server, url } = await startGatewayServer({ port: 0, host: "127.0.0.1" });
    try {
      const res = await fetch(`${url}/v1/pet?a=talk&f=40&j=70&e=80&m=${encodeURIComponent("tell me a joke")}`);
      expect(res.status).toBe(200);
      expect(await res.text()).toMatch(/"tell me a joke"/);
    } finally {
      server.close();
    }
  });
});
