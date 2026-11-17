import { useState } from "react";
import { MessageSquareText, SquareTerminal } from "lucide-react";
import { CopyBlock } from "./InstallMcpMenu.tsx";
import { launchClaudeCode, useConnectInfo } from "./client.ts";
import "./connect.css";

const STROKE = 1.6;

const FALLBACK_PROMPT = `You are connected to Fabwright, a hardware sandbox with a real simulator, through the "fabwright" MCP server.
The person is watching the live canvas; pass a short "why" on every change.
Loop: plan_device → search_parts → get_part → place_part → connect → check_design → write_file → run → write_scenario → run_tests → fix → fidelity_report.
A device to hold: think how the parts go inside; check_fit → propose_layout before design_case; say what to buy, print, assemble and flash.
Goal: <describe the device>`;

/**
 * Body of the "Open in Agent" dropdown: (a) a starter prompt to paste into any agent, (b) launch
 * Claude Code in a new Terminal, in the project folder, with Fabwright already connected. The launch
 * only runs on this explicit click, only from a page served by the local Fabwright server (it needs
 * the server's token), and the exact command is shown so it can be run by hand instead.
 */
export function OpenInAgentMenu({ onClose }: { onClose(): void }) {
  void onClose;
  const [state] = useConnectInfo(8000);
  const [withPrompt, setWithPrompt] = useState(true);
  const [launching, setLaunching] = useState(false);
  const [result, setResult] = useState<{ ok: boolean; text: string } | undefined>();
  const info = state.status === "ok" ? state.info : undefined;
  const prompt = info?.starterPrompt ?? FALLBACK_PROMPT;
  const canLaunch = !!info?.token && info.launch.available;
  const why = !info
    ? "Start Fabwright with pnpm start to launch from here."
    : !info.launch.available
      ? info.launch.why
      : !info.token
        ? `Launching needs the app opened from the Fabwright server (${info.url}). You can run the command yourself.`
        : undefined;
  return (
    <div className="menu-body cx-menu" data-testid="open-in-agent-menu">
      <div className="menu-title">Open in Agent</div>

      <div className="cx-section-title">
        <MessageSquareText size={14} strokeWidth={STROKE} aria-hidden /> Starter prompt
      </div>
      <p className="menu-text cx-muted">Paste it into any agent connected to Fabwright. It describes this project and tells the agent you are watching.</p>
      <CopyBlock text={prompt} testId="starter-prompt" label="Copy prompt" caption="Prompt" />

      <div className="cx-section-title">
        <SquareTerminal size={14} strokeWidth={STROKE} aria-hidden /> Claude Code
      </div>
      <label className="cx-check">
        <input type="checkbox" checked={withPrompt} onChange={(e) => setWithPrompt(e.target.checked)} /> Start with the prompt
      </label>
      <button
        type="button"
        className="cx-primary"
        data-testid="launch-claude-code"
        disabled={!canLaunch || launching}
        onClick={async () => {
          if (!info?.token || state.status !== "ok") return;
          setLaunching(true);
          const r = await launchClaudeCode(state.base, info.token, withPrompt);
          setLaunching(false);
          setResult(r.ok ? { ok: true, text: "Terminal opened: Claude Code is starting with Fabwright connected. Watch it build here." } : { ok: false, text: r.error ?? "Launch failed." });
        }}
      >
        <SquareTerminal size={15} strokeWidth={STROKE} aria-hidden />
        {launching ? "Opening Terminal…" : "Launch Claude Code here"}
      </button>
      {why ? <p className="menu-text cx-muted">{why}</p> : null}
      {result ? (
        <p className={`menu-text ${result.ok ? "cx-ok" : "cx-err"}`} data-testid="launch-result" role="status">
          {result.text}
        </p>
      ) : null}
      <CopyBlock text={info?.launch.command ?? "pnpm start   # then use this menu again"} testId="launch-command" caption={withPrompt ? "Runs this, plus the prompt" : "Runs exactly this"} />
      {info ? <p className="menu-text cx-muted">The command points Claude Code at a small MCP config ({info.launch.mcpConfigFile}) with this server, and the project folder gets Fabwright's hardware skill (.claude/skills/fabwright-hardware) and an AGENTS.md, so your own Claude settings stay untouched.</p> : null}
    </div>
  );
}
