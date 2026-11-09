import { useState, useSyncExternalStore } from "react";
import { Bot, Minus, Plus } from "lucide-react";
import { engine } from "../lib/app.ts";
import { ArmView, WorldView } from "../renderers/physics/index.ts";
import { IconButton, STROKE } from "../shell/primitives.tsx";

/**
 * The robot's physical world for a project with a `world` block: the arena seen from above
 * (rover) or the arm seen from the side. Shown while the local simulation exists; it reads the
 * physics binding's snapshots on each animation frame, so React never re-renders per frame.
 */
export function WorldPanel() {
  const binding = useSyncExternalStore(engine.subscribeWorld, engine.getWorld, engine.getWorld);
  const [collapsed, setCollapsed] = useState(false);
  if (!binding) return null;
  const kind = binding.world.robot ? "robot" : binding.world.arm ? "arm" : undefined;
  if (!kind) return null;
  const title = kind === "robot" ? "World · top view" : "Arm · side view";
  return (
    <section className="float-panel world-panel" data-testid="world-panel" data-world={kind} data-collapsed={collapsed} aria-label={kind === "robot" ? "Robot arena" : "Robot arm"}>
      <header className="float-panel-head">
        <Bot size={15} strokeWidth={STROKE} aria-hidden className="float-panel-icon" />
        <span className="float-panel-title">{title}</span>
        <span className="float-panel-actions">
          <IconButton icon={collapsed ? Plus : Minus} iconSize={15} className="icon-btn-sm" label={collapsed ? "Show world" : "Hide world"} onClick={() => setCollapsed((c) => !c)} />
        </span>
      </header>
      {collapsed ? null : <div className="world-panel-body">{kind === "robot" ? <WorldView binding={binding} /> : <ArmView binding={binding} />}</div>}
    </section>
  );
}
