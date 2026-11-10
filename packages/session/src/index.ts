export { ProjectSession, OP_METHODS, allOpNames, runSummary } from "./session.ts"; // round 6 switch: runSummary
export { TOOL_MODULES, EXT_OPS } from "./tools/index.ts";
export type { ExtOp, ExtOpContext, ToolModule } from "./tools/index.ts";
export type { SessionOptions, ActionEntry, SessionEvent, Builder, CallMeta } from "./session.ts";
export { TOOLS, AGENT_LOOP } from "./catalog.ts";
export type { ToolDef } from "./catalog.ts";
export { JumperError, fail, asJumperError } from "./errors.ts";
export { checkDesign } from "./drc.ts";
export type { DesignIssue } from "./drc.ts";
export { fidelityReport } from "./fidelity.ts";
export { SimHost, FAULT_KINDS, FAULTS_NOT_YET, compactState } from "./sim.ts";
export type { ColorFrameImage, Frame } from "./sim.ts";
export { runScenario, validateScenario } from "./scenario.ts";
export type { ScenarioResult } from "./scenario.ts";
export { composeSvg, svgToPng, bindSvgString, loadPlaywright } from "./screenshot.ts";
export { TEMPLATES } from "./templates.ts";
export { autoPlace } from "./layout.ts";
export { startLiveHub, createLiveHub, filterActionLog, actorCounts } from "./live.ts";
export type { LiveHub, LiveHubOptions, LiveHubCore, AgentPresence } from "./live.ts";
export { createSessionNetwork, setAiMode, readNetworkLog, runLive, setWifiDrop, NETWORK_TOOLS } from "./network.ts";
export type { SessionNetwork } from "./network.ts";
export { runScenarioVisual, compactVisual, displayPng, replayKeyframes, applyInput, snapshotDevice } from "./visual-capture.ts";
export type { VisualReport, VisualScenario, VisualFrame, VisualInput, VisualState3 } from "./visual-capture.ts";
export { buildVisualReport, loadProjectDir } from "./visual-report.ts";
export type { VisualReportOptions } from "./visual-report.ts";
export type { DeviceRenderOptions } from "./device-render.ts";

/** Headless Device view render (lazy: it loads Playwright and Vite only when called). */
export async function renderDevice(opts: import("./device-render.ts").DeviceRenderOptions): Promise<Buffer[]> {
  const m = await import("./device-render.ts");
  return m.renderDevice(opts);
}
export { jumperHome, listRegisteredProjects, newProjectFolder, projectId, projectSlug, projectsRegistryPath, registerProject, unregisterProject } from "./projects-registry.ts";
export type { ProjectsRegistryFile, RegisteredProject } from "./projects-registry.ts";
export type { AgentState, AgentStateEvent, LiveServerEvent } from "./live-events.ts";
export { projectPartProblems, projectPartsWithSvg, refreshProjectParts, registryForProjectDir } from "./tools/agentparts.ts";
// Round 5, track agent: server URL for viewer links, the pet gateway serve starts, recordings, plans.
export { setServerBase, serverBase, viewerUrlFor, projectDirById, startPetGateway } from "./agent-runtime.ts";
export type { PetGateway } from "./agent-runtime.ts";
export { recordProject, chromiumProblem } from "./recorder.ts";
export type { RecordOptions, RecordResult } from "./recorder.ts";
export { planDevice } from "./planner.ts";
export type { DevicePlan, PlanConstraints, BomLine } from "./planner.ts";
export { listVersions, versionCount, versionDetail, versionFiles, diskFirmwareFiles, lastTestsFromLog, lineDiff, recordSnapshot } from "./versions.ts"; // round 6 switch: lineDiff, recordSnapshot
export type { VersionSummary, VersionDetail, VersionChanges, VersionFrame } from "./versions.ts";
// Round 6, track power: assembly style and wire cuts (decision 0004, R2), the power report.
export { assemblyStyle, assemblyReason, wireCuts, wireCutsCsv, wireTotals, colorName } from "./assembly.ts";
export type { WireCut, AssemblyStyle } from "./assembly.ts";
export { powerReport } from "./tools/power.ts";
export type { PowerReport } from "./tools/power.ts";
export { batteryPathAdvice } from "./drc.ts";
export { deviceStill, lastLoggedStill, stillKey, type DeviceStill } from "./device-still.ts"; // round 6 frames
export { caseState, caseIsStale, caseMesh, previewFit } from "./tools/case.ts"; // round 6 case, round 7 fit preview
