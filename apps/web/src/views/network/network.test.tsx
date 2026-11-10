import { describe, expect, it } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { createSandboxNetwork } from "@jumper/ai-gateway";
import { discoverGateway, NetworkPanel, probeGateway, toRows } from "./index.ts";

function traffic() {
  const net = createSandboxNetwork();
  net.join("JumperNet", "", 2400, "esp");
  net.resolve("ai.jumper");
  const s = net.open({ host: "ai.jumper", ip: "10.0.0.2", port: 80, tls: false, tMs: 2500, partId: "esp" });
  if ("error" in s) throw new Error("refused");
  s.write("GET /v1/pet?a=talk&f=50&j=50&e=50 HTTP/1.0\r\nHost: ai.jumper\r\n\r\n", 2600);
  return net;
}

describe("network panel model", () => {
  it("turns the log into newest-first rows with status, latency and provider", () => {
    const rows = toRows(traffic().log);
    const req = rows[0]!;
    expect(req.type).toBe("request");
    if (req.type !== "request") return;
    expect(req.method).toBe("GET");
    expect(req.target).toBe("ai.jumper/v1/pet?a=talk&f=50&j=50&e=50");
    expect(req.status).toBe("200");
    expect(req.provider).toBe("Mock");
    expect(req.latency).toMatch(/^\d+ ms$/);
    expect(req.body).toMatch(/\|/);
    expect(toRows(traffic().log, { showEvents: false })).toHaveLength(1);
  });
});

describe("NetworkPanel", () => {
  it("shows the joined station, the request and switches back to mock", async () => {
    const net = traffic();
    render(<NetworkPanel net={net} />);
    expect(screen.getByText(/JumperNet · esp/)).toBeTruthy();
    expect(screen.getByText("ai.jumper/v1/pet?a=talk&f=50&j=50&e=50")).toBeTruthy();
    expect(screen.getByText("Mock (deterministic)")).toBeTruthy();
    await act(async () => {
      fireEvent.click(screen.getByRole("radio", { name: "Mock" }));
    });
    expect(net.ai.mode).toBe("mock");
  });

  it("explains how to start the gateway when live is not reachable", async () => {
    const p = await probeGateway("http://127.0.0.1:9", (async () => {
      throw new Error("refused");
    }) as unknown as typeof fetch);
    expect(p.ok).toBe(false);
    expect(p.error).toContain("no AI gateway");
  });

  it("the person can talk to the running pet: the message waits for its next question", async () => {
    cleanup();
    const net = createSandboxNetwork();
    render(<NetworkPanel net={net} />);
    const input = screen.getByLabelText("Say something to the pet") as HTMLInputElement;
    expect(input.maxLength).toBe(60);
    await act(async () => {
      fireEvent.change(input, { target: { value: "what is your favourite food?" } });
      fireEvent.click(screen.getByRole("button", { name: "Send to the pet" }));
    });
    expect(net.waitingMessage).toBe("what is your favourite food?");
    expect(input.value).toBe("");
    expect(screen.getByRole("status").textContent).toMatch(/"what is your favourite food\?" goes with the pet's next question/);
  });

  it("finds the gateway jumper serve started, or falls back to the default", async () => {
    const served = (async () => new Response(JSON.stringify({ url: "http://127.0.0.1:8790" }), { status: 200 })) as unknown as typeof fetch;
    expect(await discoverGateway("http://127.0.0.1:8787", served)).toBe("http://127.0.0.1:8790");
    const none = (async () => new Response("{}", { status: 404 })) as unknown as typeof fetch;
    expect(await discoverGateway("http://127.0.0.1:8787", none)).toBe("http://127.0.0.1:8787");
    const evil = (async () => new Response(JSON.stringify({ url: "http://evil.example:80" }), { status: 200 })) as unknown as typeof fetch;
    expect(await discoverGateway("http://127.0.0.1:8787", evil)).toBe("http://127.0.0.1:8787");
  });
});
