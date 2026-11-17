/**
 * Every error an agent can see says what failed, why, and how to fix it. Agents read errors
 * literally, so the fix is a concrete next call or edit, not advice.
 */
export class FabwrightError extends Error {
  readonly code: string;
  readonly what: string;
  readonly why: string;
  readonly fix: string;
  readonly details: Record<string, unknown> | undefined;

  constructor(code: string, what: string, why: string, fix: string, details?: Record<string, unknown>) {
    super(`${what}: ${why}. Fix: ${fix}`);
    this.name = "FabwrightError";
    this.code = code;
    this.what = what;
    this.why = why;
    this.fix = fix;
    this.details = details;
  }

  toJSON(): Record<string, unknown> {
    return { code: this.code, message: this.message, ...(this.details ? { details: this.details } : {}) };
  }
}

export function fail(code: string, what: string, why: string, fix: string, details?: Record<string, unknown>): never {
  throw new FabwrightError(code, what, why, fix, details);
}

/** Wrap any thrown value as a FabwrightError (keeps FabwrightErrors as they are). */
export function asFabwrightError(err: unknown, what = "Operation failed"): FabwrightError {
  if (err instanceof FabwrightError) return err;
  const e = err as { code?: string; message?: string };
  const msg = e?.message ?? String(err);
  if (e && typeof e.code === "string" && /Fix:/.test(msg)) {
    // RunnerError and friends already carry a fix.
    const j = new FabwrightError(e.code, what, msg, "see above");
    Object.defineProperty(j, "message", { value: msg });
    return j;
  }
  return new FabwrightError("internal", what, msg, "this looks like a Fabwright bug; report it with the action log (.fabwright/actions.jsonl) attached");
}

/** "did you mean" helper: closest strings by edit distance (case-insensitive). */
export function closest(input: string, options: readonly string[], max = 3): string[] {
  const a = input.toLowerCase();
  const scored = options.map((o) => ({ o, d: lev(a, o.toLowerCase()) - (o.toLowerCase().includes(a) || a.includes(o.toLowerCase()) ? 2 : 0) }));
  scored.sort((x, y) => x.d - y.d || (x.o < y.o ? -1 : 1));
  const limit = Math.max(2, Math.ceil(a.length / 2));
  return scored.filter((s) => s.d <= limit).slice(0, max).map((s) => s.o);
}

function lev(a: string, b: string): number {
  const m = a.length;
  const n = b.length;
  if (!m) return n;
  if (!n) return m;
  let prev = Array.from({ length: n + 1 }, (_, j) => j);
  for (let i = 1; i <= m; i++) {
    const cur = [i];
    for (let j = 1; j <= n; j++) cur[j] = Math.min(prev[j]! + 1, cur[j - 1]! + 1, prev[j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1));
    prev = cur;
  }
  return prev[n]!;
}

export function didYouMean(input: string, options: readonly string[]): string {
  const c = closest(input, options);
  return c.length ? ` Did you mean ${c.map((x) => `'${x}'`).join(" or ")}?` : "";
}
