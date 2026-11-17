/**
 * `/?local` on the same `faber serve` server, when the page follows that server
 * (`?follow=ws://<same host>/live`); undefined otherwise. That page opens the followed project with
 * its built firmware, so Run, the buttons and the Device view work there.
 */
export function localCopyUrl(loc: { search: string; origin: string; host: string } | undefined = typeof location === "undefined" ? undefined : location): string | undefined {
  if (!loc) return undefined;
  const follow = new URLSearchParams(loc.search).get("follow");
  if (!follow) return undefined;
  try {
    return new URL(follow).host === loc.host ? `${loc.origin}/?local` : undefined;
  } catch {
    return undefined;
  }
}
