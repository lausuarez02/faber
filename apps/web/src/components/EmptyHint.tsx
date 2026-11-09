import { Plug, Plus, Sparkles } from "lucide-react";
import { useJumper } from "../lib/app.ts";
import { useUi } from "../lib/ui.ts";
import { STROKE } from "../shell/primitives.tsx";

/**
 * A node-style card under a lone board: what to do first on an empty canvas. It goes away as
 * soon as the project has a second part or a wire.
 */
export function EmptyHint() {
  const empty = useJumper((s) => s.project.parts.length <= 1 && s.project.wires.length === 0);
  const popover = useUi((s) => s.popover);
  if (!empty || popover) return null;
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
