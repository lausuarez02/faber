import { describe, expect, it } from "vitest";
import { localCopyUrl } from "./localCopy.ts";

describe("localCopyUrl", () => {
  const at = (search: string) => ({ search, origin: "http://localhost:7780", host: "localhost:7780" });
  it("points a page following its own jumper serve at /?local", () => {
    expect(localCopyUrl(at(`?follow=${encodeURIComponent("ws://localhost:7780/live")}`))).toBe("http://localhost:7780/?local");
  });
  it("is undefined when not following, or following another server", () => {
    expect(localCopyUrl(at(""))).toBeUndefined();
    expect(localCopyUrl(at("?follow=ws://127.0.0.1:7782"))).toBeUndefined();
    expect(localCopyUrl(at("?follow=not a url"))).toBeUndefined();
  });
});
