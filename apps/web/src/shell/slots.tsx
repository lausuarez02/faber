import { liveChrome, liveStage } from "../live/slots.tsx";
import { projectsChrome, projectsStage } from "../projects/slots.tsx";

/**
 * Round 5 mount points (decision 0003, C8): each track adds its components to its own slots file
 * instead of editing App.tsx. Order here is fixed; tracks only touch their own arrays.
 */
const STAGE = [...projectsStage, ...liveStage];
const CHROME = [...projectsChrome, ...liveChrome];

export function StageSlots() {
  return (
    <>
      {STAGE.map((C, i) => (
        <C key={i} />
      ))}
    </>
  );
}

export function ChromeSlots() {
  return (
    <>
      {CHROME.map((C, i) => (
        <C key={i} />
      ))}
    </>
  );
}
