import { agentpartsChrome, agentpartsStage } from "../agentparts/slots.tsx";
import { caseChrome, caseStage } from "../case/slots.tsx"; // round 6 case
import { kitChrome, kitStage } from "../kit/slots.tsx"; // round 12 kit
import { liveChrome, liveStage } from "../live/slots.tsx";
import { projectsChrome, projectsStage } from "../projects/slots.tsx";
import { powerChrome, powerStage } from "../power/slots.tsx"; // round 6 power

/**
 * Round 5 mount points (decision 0003, C8): each track adds its components to its own slots file
 * instead of editing App.tsx. Order here is fixed; tracks only touch their own arrays.
 */
const STAGE = [...projectsStage, ...liveStage, ...agentpartsStage, ...powerStage, ...caseStage, ...kitStage]; // round 6 power, case; round 12 kit
const CHROME = [...projectsChrome, ...liveChrome, ...agentpartsChrome, ...powerChrome, ...caseChrome, ...kitChrome];

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
