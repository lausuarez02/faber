import { describe, expect, it } from "vitest";
import { busyText, DEFAULT_SERVER, serverCandidates, type AgentInfo } from "./client.ts";

describe("connect client", () => {
  it("looks for the server at the followed hub, this origin, then localhost:7780", () => {
    expect(serverCandidates({ search: "?follow=ws%3A%2F%2Flocalhost%3A7790%2Flive", origin: "http://127.0.0.1:5173" })).toEqual(["http://localhost:7790", "http://127.0.0.1:5173", DEFAULT_SERVER]);
    expect(serverCandidates({ search: "", origin: "http://localhost:7780" })).toEqual(["http://localhost:7780"]);
    expect(serverCandidates({ search: "?follow=not a url", origin: "file://" })).toEqual([DEFAULT_SERVER]);
  });

  it("says what an agent is doing in a few words", () => {
    const a = { busy: { op: "place_part", target: "led", since: "" } } as AgentInfo;
    expect(busyText(a)).toBe("place part led");
    expect(busyText({ ...a, busy: undefined })).toBeUndefined();
  });
});
