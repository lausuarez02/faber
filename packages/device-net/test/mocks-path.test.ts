// Round 10 eval fix: a mock path with a query ("/v1/forecast?latitude=51.51*") never matched,
// because the query was cut off the request but not off the pattern. Mocks per query now work.
import { describe, expect, it } from "vitest";
import { MockSet, pathMatches } from "../src/mocks.ts";

describe("mock path patterns", () => {
  it("keeps the old rules: exact, prefix*, query ignored when the pattern has none", () => {
    expect(pathMatches("/v1/forecast", "/v1/forecast?latitude=1")).toBe(true);
    expect(pathMatches("/v1/forecast", "/v1/forecasts")).toBe(false);
    expect(pathMatches("/v1/*", "/v1/forecast?x=1")).toBe(true);
  });

  it("a query in the pattern needs those parameters, any order, others allowed", () => {
    const real = "/v1/forecast?latitude=51.51&longitude=-0.13&current=temperature_2m&forecast_hours=6";
    expect(pathMatches("/v1/forecast?latitude=51.51&longitude=-0.13*", real)).toBe(true);
    expect(pathMatches("/v1/forecast?longitude=-0.13&latitude=51.51", real)).toBe(true);
    expect(pathMatches("/v1/forecast?latitude=40.42&longitude=-3.70*", real)).toBe(false);
    expect(pathMatches("/v1/forecast?latitude=51*", real)).toBe(true);
    expect(pathMatches("/v1/forecast?city=London", "/v1/forecast?city=London%20")).toBe(false);
    expect(pathMatches("/v1/forecast?city=New York", "/v1/forecast?city=New+York")).toBe(true);
    expect(pathMatches("/v1/forecast?latitude=51.51", "/v1/forecast")).toBe(false);
  });

  it("two mocks for one API answer two places differently", () => {
    const set = new MockSet([
      { host: "api.open-meteo.com", path: "/v1/forecast?latitude=51.51*", response: { body: { place: "london" } } },
      { host: "api.open-meteo.com", path: "/v1/forecast?latitude=40.42*", response: { body: { place: "madrid" } } },
    ]);
    const m = set.http("api.open-meteo.com", "GET", "/v1/forecast?latitude=40.42&longitude=-3.70&hourly=precipitation_probability");
    expect((m?.response.body as { place: string }).place).toBe("madrid");
    expect(set.http("api.open-meteo.com", "GET", "/v1/forecast?latitude=1&longitude=2")).toBeUndefined();
  });
});
