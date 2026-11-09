import { LayoutGrid, Plug, Plus, Sparkles } from "lucide-react";
import { useJumper } from "../lib/app.ts";
import { exampleInfos } from "../lib/examples.ts";
import { useUi } from "../lib/ui.ts";
import { useLive } from "../live/liveStore.ts";
import { STROKE } from "../shell/primitives.tsx";
import { LogoMark } from "./Logo.tsx";
import { openCard, openLocalExample } from "../projects/actions.ts";
import { useProjectsListing, useServer } from "../projects/data.ts";
import { Card, LocalExampleCard, PITCH } from "../projects/ProjectsHome.tsx";
import { useProjectsUi } from "../projects/store.ts";

/**
 * What an empty canvas says. No parts at all: a centred welcome with the one-line pitch, example
 * cards (each opens as its own project) and "or press + to add a part". A lone board: the small
 * "Start here" card under it.
 */
export function EmptyHint() {
  const parts = useJumper((s) => s.project.parts.length);
  const wires = useJumper((s) => s.project.wires.length);
  const popover = useUi((s) => s.popover);
  const overlay = useProjectsUi((s) => s.home || s.history);
  if (overlay) return null;
  if (parts === 0 && wires === 0) return <EmptyState />;
  if (parts > 1 || wires > 0 || popover) return null;
  const ui = useUi.getState;
  return (
    <div className="empty-hint" data-testid="empty-hint">
      <div className="empty-hint-label">
        <Sparkles size={12} strokeWidth={STROKE} aria-hidden /> Start here
      </div>
      <div className="empty-hint-card">
        <p>Drop parts next to the board and wire them up, or let an agent build it while you watch.</p>
        <div className="empty-hint-actions">
          <button type="button" className="empty-hint-btn" onClick={() => ui().setPopover("parts")}>
            <Plus size={14} strokeWidth={STROKE} aria-hidden /> Add a part <kbd>A</kbd>
          </button>
          <button type="button" className="empty-hint-btn" onClick={() => ui().setPopover("mcp")}>
            <Plug size={14} strokeWidth={STROKE} aria-hidden /> Connect an agent
          </button>
        </div>
      </div>
    </div>
  );
}

const SHOWN = 4;

function EmptyState() {
  const server = useServer();
  const live = useLive((s) => s.mode);
  const popover = useUi((s) => s.popover);
  const { data } = useProjectsListing(server === "yes");
  const ui = useUi.getState;
  if (popover === "parts") return null;
  const cards = data?.examples.filter((c) => c.kind === "example").slice(0, SHOWN);
  return (
    <div className="empty-state" data-testid="empty-state" data-live={live}>
      <div className="empty-state-inner">
        <LogoMark size={30} mono />
        <h2 className="empty-state-title">{PITCH}</h2>
        {live === "follow" ? <p className="empty-state-sub">This is your agent's project and it is empty. Ask your agent to build something, or start from an example.</p> : <p className="empty-state-sub">Start from an example. It opens as its own project, so nothing here is replaced.</p>}
        <div className="empty-state-grid" data-testid="empty-state-examples">
          {server === "yes" && cards
            ? cards.map((c) => <Card key={c.id} card={c} compact onOpen={() => void openCard(c)} />)
            : server === "no"
              ? exampleInfos()
                  .slice(0, SHOWN)
                  .map((ex) => <LocalExampleCard key={ex.example} info={ex} compact onOpen={() => openLocalExample(ex.example)} />)
              : null}
        </div>
        <div className="empty-state-foot">
          <span>
            or press{" "}
            <button type="button" className="empty-state-plus" aria-label="Add a part" data-testid="empty-state-add" onClick={() => ui().setPopover("parts")}>
              <Plus size={14} strokeWidth={STROKE} aria-hidden />
            </button>{" "}
            to add a part
          </span>
          <span className="empty-state-sep" aria-hidden>
            ·
          </span>
          <button type="button" className="empty-state-link" onClick={() => ui().setPopover("mcp")}>
            <Plug size={13} strokeWidth={STROKE} aria-hidden /> Connect an agent
          </button>
          <span className="empty-state-sep" aria-hidden>
            ·
          </span>
          <button type="button" className="empty-state-link" data-testid="empty-state-all" onClick={() => useProjectsUi.getState().setHome(true)}>
            <LayoutGrid size={13} strokeWidth={STROKE} aria-hidden /> All projects
          </button>
        </div>
      </div>
    </div>
  );
}
