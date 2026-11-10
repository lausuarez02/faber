import { useEffect, useState } from "react";
import { Bot, CircuitBoard, FlaskConical, FolderOpen, Plus, X } from "lucide-react";
import { useJumper } from "../lib/app.ts";
import { exampleInfos, type ExampleInfo } from "../lib/examples.ts";
import { getDef } from "../lib/parts.ts";
import { LogoMark } from "../components/Logo.tsx";
import { STROKE } from "../shell/primitives.tsx";
import { ago, type ProjectCard } from "./api.ts";
import { newProjectAnywhere, openCard, openLocalExample } from "./actions.ts";
import { useProjectsListing, useServer } from "./data.ts";
import { useProjectsUi } from "./store.ts";
import "./projects.css";

export const PITCH = "Build and simulate Arduino circuits, or let your AI agent build them while you watch.";

/**
 * The Projects home: every project the local server knows (projects folder, examples, agent-built
 * examples, folders agents and `--project` registered), as cards with a rendered thumbnail, board,
 * test result and last change. Opened from the logo. Examples open as their own copy, never over
 * the circuit on the canvas.
 */
export function ProjectsHome() {
  const open = useProjectsUi((s) => s.home);
  const server = useServer();
  const { data, error, loading } = useProjectsListing(open);
  const [busy, setBusy] = useState<string | undefined>();

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") useProjectsUi.getState().setHome(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);

  if (!open) return null;
  const close = () => useProjectsUi.getState().setHome(false);
  const run = async (key: string, fn: () => Promise<void> | void) => {
    setBusy(key);
    try {
      await fn();
    } finally {
      setBusy(undefined);
    }
  };
  const examples = data?.examples.filter((c) => c.kind === "example") ?? [];
  const agentBuilt = data?.examples.filter((c) => c.kind === "agent-built") ?? [];

  return (
    <div className="pj-home" role="dialog" aria-modal="true" aria-label="Projects" data-testid="projects-home" data-server={server ?? "unknown"}>
      <header className="pj-home-head">
        <div className="pj-home-brand">
          <LogoMark size={22} mono />
          <h1>Projects</h1>
        </div>
        <div className="pj-home-actions">
          <button type="button" className="pj-btn pj-btn-primary" data-testid="projects-new" disabled={!!busy} onClick={() => void run("new", () => newProjectAnywhere())}>
            <Plus size={16} strokeWidth={STROKE} aria-hidden /> New project
          </button>
          <button type="button" className="icon-btn" aria-label="Back to the canvas" title="Back to the canvas (Esc)" data-testid="projects-close" onClick={close}>
            <X size={18} strokeWidth={STROKE} aria-hidden />
          </button>
        </div>
      </header>
      <div className="pj-home-body">
        <p className="pj-pitch">{PITCH}</p>

        <section className="pj-section" aria-labelledby="pj-yours">
          <h2 id="pj-yours">Your projects</h2>
          {server === "yes" ? (
            error ? (
              <p className="pj-callout pj-callout-error" role="alert">
                {error}
              </p>
            ) : loading && !data ? (
              <div className="pj-grid" aria-busy="true">
                <div className="pj-card pj-card-skeleton" />
                <div className="pj-card pj-card-skeleton" />
              </div>
            ) : (
              <div className="pj-grid" data-testid="projects-grid">
                {data?.projects.map((c) => <Card key={c.id} card={c} active={c.id === data.active} busy={busy === c.id} onOpen={() => (c.id === data.active ? close() : void run(c.id, () => openCard(c)))} />)}
                <button type="button" className="pj-card pj-card-new" disabled={!!busy} onClick={() => void run("new", () => newProjectAnywhere())}>
                  <Plus size={22} strokeWidth={STROKE} aria-hidden />
                  <span>New blank project</span>
                </button>
              </div>
            )
          ) : server === "no" ? (
            <>
              <div className="pj-grid">
                <CurrentCanvasCard onOpen={close} />
              </div>
              <p className="pj-callout" data-testid="projects-no-server">
                Projects are saved as folders by the local server. Run <code>pnpm start</code> (or <code>jumper serve --project &lt;folder&gt;</code>) and open the address it prints to keep every project, see its history and edit its code here.
              </p>
            </>
          ) : null}
        </section>

        <section className="pj-section" aria-labelledby="pj-examples">
          <h2 id="pj-examples">Examples</h2>
          <p className="pj-section-note">Opening an example makes your own copy; nothing on your canvas is replaced.</p>
          <div className="pj-grid" data-testid="examples-grid">
            {server === "yes"
              ? examples.map((c) => <Card key={c.id} card={c} busy={busy === c.id} onOpen={() => void run(c.id, () => openCard(c))} />)
              : server === "no"
                ? exampleInfos().map((ex) => <LocalExampleCard key={ex.example} info={ex} onOpen={() => openLocalExample(ex.example)} />)
                : null}
          </div>
        </section>

        {agentBuilt.length ? (
          <section className="pj-section" aria-labelledby="pj-agents">
            <h2 id="pj-agents">Built by agents</h2>
            <p className="pj-section-note">Claude Code and Codex built these with only Jumper's tools. Open one to scrub through how it was made.</p>
            <div className="pj-grid">
              {agentBuilt.map((c) => (
                <Card key={c.id} card={c} busy={busy === c.id} onOpen={() => void run(c.id, () => openCard(c))} />
              ))}
            </div>
          </section>
        ) : null}
      </div>
    </div>
  );
}

function testsChip(card: ProjectCard) {
  if (card.tests) {
    const ok = card.tests.passed === card.tests.total;
    return (
      <span className={`pj-chip ${ok ? "is-good" : "is-bad"}`} title={card.tests.at ? `last run ${ago(card.tests.at)}` : undefined}>
        <FlaskConical size={12} strokeWidth={STROKE} aria-hidden /> tests {card.tests.passed}/{card.tests.total}
      </span>
    );
  }
  if (card.scenarios) return <span className="pj-chip">{card.scenarios} tests</span>;
  return null;
}

export function Card({ card, active, busy, onOpen, compact }: { card: ProjectCard; active?: boolean; busy?: boolean; onOpen(): void; compact?: boolean }) {
  const [broken, setBroken] = useState(false);
  return (
    <button type="button" className={`pj-card${compact ? " pj-card-compact" : ""}`} data-testid={`project-card-${card.id}`} data-name={card.name} data-kind={card.kind} data-active={active ? "true" : undefined} aria-busy={busy || undefined} onClick={onOpen} title={card.readOnly ? `Open a copy of ${card.name}` : `Open ${card.name}`}>
      <div className="pj-thumb">
        {card.parts && !broken ? <img src={card.thumbnail} alt="" loading="lazy" onError={() => setBroken(true)} /> : <EmptyThumb parts={card.parts} />}
        {active ? <span className="pj-badge">Open now</span> : null}
        {card.kind === "agent-built" ? (
          <span className="pj-badge pj-badge-agent">
            <Bot size={12} strokeWidth={STROKE} aria-hidden /> agent
          </span>
        ) : null}
      </div>
      <div className="pj-card-body">
        <div className="pj-card-title">{card.name}</div>
        {card.description && !compact ? <div className="pj-card-desc">{card.description}</div> : null}
        <div className="pj-card-meta">
          {card.boardName ? <span>{card.boardName.replace(/\s+R\d+$/, "")}</span> : <span>No board yet</span>}
          <span>
            {card.parts} part{card.parts === 1 ? "" : "s"}
          </span>
          {card.agentMade ? (
            <span className="pj-chip pj-made" title={`${card.agentMade} part type${card.agentMade === 1 ? "" : "s"} made by an agent with create_part: agent-made, behavioral, unverified against the real part`}>
              {card.agentMade} agent-made
            </span>
          ) : null}
          {testsChip(card)}
          {!card.readOnly ? <span className="pj-when">{ago(card.updatedAt)}</span> : null}
        </div>
      </div>
      {busy ? <div className="pj-card-busy">Opening…</div> : null}
    </button>
  );
}

function EmptyThumb({ parts }: { parts: number }) {
  return (
    <div className="pj-thumb-empty">
      <CircuitBoard size={28} strokeWidth={1.2} aria-hidden />
      <span>{parts ? `${parts} parts` : "Empty canvas"}</span>
    </div>
  );
}

export function LocalExampleCard({ info, onOpen, compact }: { info: ExampleInfo; onOpen(): void; compact?: boolean }) {
  const board = info.board ? getDef(info.board)?.spec.name.replace(/\s+R\d+$/, "") : undefined;
  return (
    <button type="button" className={`pj-card${compact ? " pj-card-compact" : ""}`} data-testid={`example-card-${info.example}`} data-name={info.title} data-kind="example" onClick={onOpen}>
      <div className="pj-thumb">
        <EmptyThumb parts={info.parts} />
      </div>
      <div className="pj-card-body">
        <div className="pj-card-title">{info.title}</div>
        {info.description && !compact ? <div className="pj-card-desc">{info.description}</div> : null}
        <div className="pj-card-meta">
          {board ? <span>{board}</span> : null}
          <span>{info.parts} parts</span>
          {info.scenarios ? <span className="pj-chip">{info.scenarios} tests</span> : null}
        </div>
      </div>
    </button>
  );
}

function CurrentCanvasCard({ onOpen }: { onOpen(): void }) {
  const project = useJumper((s) => s.project);
  return (
    <button type="button" className="pj-card" data-testid="project-card-current" data-active="true" onClick={onOpen}>
      <div className="pj-thumb">
        <EmptyThumb parts={project.parts.length} />
        <span className="pj-badge">Open now</span>
      </div>
      <div className="pj-card-body">
        <div className="pj-card-title">{project.name}</div>
        <div className="pj-card-meta">
          <span>This browser tab</span>
          <span>
            <FolderOpen size={12} strokeWidth={STROKE} aria-hidden /> not saved to a folder
          </span>
        </div>
      </div>
    </button>
  );
}
