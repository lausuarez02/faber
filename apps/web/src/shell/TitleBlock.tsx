import { useRef } from "react";
import { Code2, Cpu, Download, Ellipsis, FilePlus2, FileText, FolderOpen, History, LayoutGrid, ListChecks, Pencil, Upload } from "lucide-react";
import { useJumper } from "../lib/app.ts";
import { exampleNames } from "../lib/examples.ts";
import { useUi } from "../lib/ui.ts";
import { useLive } from "../live/liveStore.ts";
import { LogoMark } from "../components/Logo.tsx";
import { MenuItem, Popover, STROKE } from "./primitives.tsx";
import { boardOf, exportBom, exportNetlist, exportProject, importProjectFile, loadHexFile, pickFile } from "./actions.ts";
import { newProjectAnywhere, openExampleByName } from "../projects/actions.ts";
import { useProjectsUi } from "../projects/store.ts";

/** Top-left: mark, project name + "…" menu, and the muted subtitle. No container. */
export function TitleBlock() {
  const name = useJumper((s) => s.project.name);
  const subtitle = useSubtitle();
  const nameRef = useRef<HTMLInputElement>(null);
  const close = () => useUi.getState().setPopover(null);

  return (
    <div className="title-block">
      <div className="title-row">
        <button type="button" className="title-logo" aria-label="All projects" title="All projects" data-testid="open-projects" onClick={() => useProjectsUi.getState().setHome(true)}>
          <LogoMark size={22} mono />
        </button>
        <input
          ref={nameRef}
          className="project-name"
          aria-label="Project name"
          defaultValue={name}
          key={name}
          onBlur={(e) => useJumper.getState().rename(e.currentTarget.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") e.currentTarget.blur();
            if (e.key === "Escape") {
              e.currentTarget.value = name;
              e.currentTarget.blur();
            }
          }}
        />
        <div className="anchor">
          <button
            type="button"
            className="icon-btn icon-btn-sm title-menu-btn"
            aria-label="Project menu"
            title="Project menu"
            aria-expanded={useUi((s) => s.popover === "project")}
            data-testid="project-menu"
            data-popover-trigger="project"
            onClick={() => useUi.getState().togglePopover("project")}
          >
            <Ellipsis size={18} strokeWidth={STROKE} aria-hidden />
          </button>
          <Popover id="project" label="Project menu" className="popover-menu popover-below-left">
            <div role="menu">
              <MenuItem
                icon={Pencil}
                onSelect={() => {
                  close();
                  requestAnimationFrame(() => nameRef.current?.select());
                }}
              >
                Rename
              </MenuItem>
              <MenuItem
                icon={FilePlus2}
                onSelect={() => {
                  close();
                  void newProjectAnywhere();
                }}
                testId="new-project"
              >
                New project
              </MenuItem>
              <MenuItem icon={LayoutGrid} onSelect={() => (close(), useProjectsUi.getState().setHome(true))} testId="menu-all-projects">
                All projects…
              </MenuItem>
              <MenuItem icon={History} onSelect={() => (close(), useProjectsUi.getState().setHistory(true))} testId="menu-history">
                History
              </MenuItem>
              <MenuItem icon={Code2} onSelect={() => (close(), useProjectsUi.getState().openCode())} testId="menu-code">
                Code
              </MenuItem>
              <div className="menu-sep" />
              <MenuItem icon={Download} onSelect={() => (exportProject(), close())} testId="export-project">
                Export jumper.json
              </MenuItem>
              <MenuItem icon={Upload} onSelect={() => (close(), pickFile(".json,application/json", (f) => void importProjectFile(f)))} testId="import-project">
                Open jumper.json…
              </MenuItem>
              <MenuItem icon={Cpu} onSelect={() => (close(), pickFile(".hex,text/plain", (f) => void loadHexFile(f)))}>
                Load firmware .hex…
              </MenuItem>
              <MenuItem icon={ListChecks} onSelect={() => (exportBom(), close())}>
                Export BOM (.csv)
              </MenuItem>
              <MenuItem icon={FileText} onSelect={() => (exportNetlist(), close())}>
                Export netlist
              </MenuItem>
              <div className="menu-sep" />
              <div className="menu-label">Examples</div>
              {exampleNames().map((ex) => (
                <a
                  key={ex}
                  role="menuitem"
                  className="menu-item"
                  href={`?example=${encodeURIComponent(ex)}`}
                  data-testid={`example-${ex}`}
                  onClick={(e) => {
                    // Opens as its own project (a copy on the server, a new tab when this canvas has work).
                    if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;
                    e.preventDefault();
                    close();
                    void openExampleByName(ex);
                  }}
                >
                  <span className="menu-item-icon">
                    <FolderOpen size={16} strokeWidth={STROKE} aria-hidden />
                  </span>
                  <span className="menu-item-label">{ex}</span>
                </a>
              ))}
            </div>
          </Popover>
        </div>
        <button type="button" className="icon-btn icon-btn-sm title-history-btn" aria-label="History" title="History: every version of this project" data-testid="open-history" onClick={() => useProjectsUi.getState().setHistory(true)}>
          <History size={16} strokeWidth={STROKE} aria-hidden />
        </button>
      </div>
      <div className="title-sub" data-testid="project-subtitle">
        {subtitle}
      </div>
    </div>
  );
}

function useSubtitle(): string {
  const mode = useLive((s) => s.mode);
  const dir = useLive((s) => s.dir);
  const project = useJumper((s) => s.project);
  const board = boardOf(project);
  const n = project.parts.length;
  const where = mode === "follow" ? `Following ${dir ? dir.split("/").slice(-2).join("/") : "agent session"}` : mode === "replay" ? "Replay" : "Local workspace";
  return [where, board?.name, `${n} part${n === 1 ? "" : "s"}`].filter(Boolean).join(" · ");
}
