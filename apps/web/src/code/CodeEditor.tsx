import { useCallback, useEffect, useRef, useState } from "react";
import { AlertTriangle, CircleCheck, FileCode2, Loader2, Lock, Play, Save, X } from "lucide-react";
import { engine, initialExample, useJumper } from "../lib/app.ts";
import { exampleSources } from "../lib/examples.ts";
import { useLive } from "../live/liveStore.ts";
import { STROKE } from "../shell/primitives.tsx";
import { NO_SERVER, api, type BuildResponse } from "../projects/api.ts";
import { useServer } from "../projects/data.ts";
import { useProjectsUi } from "../projects/store.ts";
import { createEditor, type CodeEditorHandle, type CompileDiagnostic } from "./editor.ts";
import "./code.css";

type Status =
  | { kind: "idle" }
  | { kind: "saving" }
  | { kind: "saved"; at: number }
  | { kind: "building" }
  | { kind: "built"; res: BuildResponse }
  | { kind: "failed"; res: BuildResponse }
  | { kind: "error"; message: string };

interface Buffer {
  saved: string;
  text: string;
}

/**
 * The code editor drawer: the project's firmware files in CodeMirror, Save (write_file) and
 * Build & Run (build, then run) through the local server, so the canvas, the CLI and agents share
 * one path (actor "web" in the action log). Compile errors appear at their line. Without a server
 * it is a read-only viewer of the example's code; a History snapshot is read-only too.
 */
export function CodeEditor() {
  const code = useProjectsUi((s) => s.code);
  const tick = useProjectsUi((s) => s.tick);
  const server = useServer();
  const projectName = useJumper((s) => s.project.name);
  const [files, setFiles] = useState<string[]>([]);
  const [path, setPath] = useState<string | undefined>();
  const [status, setStatus] = useState<Status>({ kind: "idle" });
  const [loadError, setLoadError] = useState<string | undefined>();
  const buffers = useRef(new Map<string, Buffer>());
  const diags = useRef<CompileDiagnostic[]>([]);
  const host = useRef<HTMLDivElement>(null);
  const editor = useRef<CodeEditorHandle | undefined>(undefined);
  const [, rerender] = useState(0);
  const snapshot = code.snapshot;
  const editable = server === "yes" && !snapshot;
  const source = snapshot ? "snapshot" : server === "yes" ? "server" : server === "no" ? "example" : undefined;

  const showDiagnostics = useCallback((p: string | undefined) => {
    if (!editor.current || !p) return;
    editor.current.setDiagnostics(diags.current.filter((d) => d.file === p || (d.file && p.endsWith(d.file)) || (d.file && d.file.endsWith(p.replace(/^firmware\//, "")))));
  }, []);

  // Create CodeMirror once the drawer is open.
  useEffect(() => {
    if (!code.open || !host.current) return;
    const ed = createEditor(host.current, {
      onChange: (text) => {
        const p = currentPath.current;
        if (!p) return;
        const b = buffers.current.get(p);
        if (b && b.text !== text) {
          b.text = text;
          rerender((x) => x + 1);
        }
      },
      onSave: () => void saveRef.current(),
      onBuild: () => void buildRef.current(),
    });
    editor.current = ed;
    return () => {
      ed.destroy();
      editor.current = undefined;
      buffers.current.clear();
      loaded.current = undefined;
      diags.current = [];
      setStatus({ kind: "idle" });
      setFiles([]);
      setPath(undefined);
    };
  }, [code.open]);

  const currentPath = useRef<string | undefined>(undefined);
  /** The path whose text is in the editor now. */
  const loaded = useRef<string | undefined>(undefined);
  currentPath.current = path;

  // The file list.
  useEffect(() => {
    if (!code.open || !source) return;
    let alive = true;
    (async () => {
      try {
        let list: string[];
        if (source === "snapshot") {
          list = Object.keys(snapshot!.files).filter((f) => f.startsWith("firmware/")).sort();
          for (const f of list) buffers.current.set(f, { saved: snapshot!.files[f]!, text: snapshot!.files[f]! });
        } else if (source === "server") {
          const r = await api.files();
          list = r.files.map((f) => f.path).filter((f) => !/\.(hex|bin|elf|eep)$/.test(f));
          if (!code.path && r.main && !list.includes(r.main)) list.unshift(r.main);
        } else {
          const p = useJumper.getState().project;
          const sameAsExample = p.name === initialExample.project.name && initialExample.source === "file";
          const src = sameAsExample ? await exampleSources(initialExample.example) : {};
          list = Object.keys(src).sort();
          for (const f of list) buffers.current.set(f, { saved: src[f]!, text: src[f]! });
        }
        if (!alive) return;
        setFiles(list);
        setLoadError(undefined);
        const main = useJumper.getState().project.firmware?.sketch;
        setPath((cur) => cur ?? (code.path && list.includes(code.path) ? code.path : list.find((f) => main && f === `firmware/${main}`) ?? list.find((f) => /\.ino$/.test(f)) ?? list[0]));
      } catch (e) {
        if (alive) setLoadError((e as Error).message);
      }
    })();
    return () => {
      alive = false;
    };
  }, [code.open, source, snapshot, code.path, tick]);

  // Follow requests to open a specific file while already open.
  useEffect(() => {
    if (code.open && code.path) setPath(code.path);
  }, [code.open, code.path]);

  // Load the selected file into the editor.
  useEffect(() => {
    if (!code.open || !path || !editor.current) return;
    let alive = true;
    (async () => {
      let b = buffers.current.get(path);
      // From the server: first load, and again after a change elsewhere (an agent's write_file)
      // unless the person has unsaved edits in it.
      if (source === "server" && (!b || b.text === b.saved)) {
        try {
          const r = await api.file(path);
          if (b && b.saved === r.content && loaded.current === path) return;
          b = { saved: r.content, text: r.content };
          buffers.current.set(path, b);
        } catch (e) {
          if (b) return; // a new file that is not saved yet
          if (alive) setLoadError((e as Error).message);
          return;
        }
      }
      if (!alive || !editor.current) return;
      editor.current.setDoc(b?.text ?? "", !editable);
      loaded.current = path;
      showDiagnostics(path);
    })();
    return () => {
      alive = false;
    };
  }, [code.open, path, source, editable, showDiagnostics, tick]);

  const dirtyPaths = () => [...buffers.current].filter(([, b]) => b.text !== b.saved).map(([p]) => p);

  const save = async (): Promise<boolean> => {
    if (!editable) return false;
    const dirty = dirtyPaths();
    if (!dirty.length) return true;
    setStatus({ kind: "saving" });
    try {
      for (const p of dirty) {
        const b = buffers.current.get(p)!;
        const text = b.text;
        await api.saveFile(p, text);
        b.saved = text;
      }
      setStatus({ kind: "saved", at: Date.now() });
      rerender((x) => x + 1);
      return true;
    } catch (e) {
      setStatus({ kind: "error", message: (e as Error).message });
      return false;
    }
  };

  const build = async () => {
    if (!editable) return;
    if (!(await save())) return;
    setStatus({ kind: "building" });
    try {
      const res = await api.build(true);
      diags.current = res.diagnostics ?? [];
      showDiagnostics(currentPath.current);
      if (!res.ok) {
        setStatus({ kind: "failed", res });
        const first = res.diagnostics.find((d) => d.severity === "error" && d.file);
        if (first?.file) {
          const target = files.find((f) => f === first.file || f.endsWith(first.file!)) ?? first.file;
          if (target !== currentPath.current) setPath(target);
          else if (first.line) editor.current?.goto(first.line, first.column);
        }
        return;
      }
      setStatus({ kind: "built", res });
      // A page running its own simulation loads the new firmware and runs it; a followed canvas
      // shows the server's run (and, with the live track, reloads its own sim on the firmware event).
      if (useLive.getState().mode === "off" && res.hex) {
        engine.stop();
        useJumper.getState().setFirmware({ status: "ready", hex: res.hex, name: currentPath.current ?? "sketch", source: "upload" });
        engine.run();
      }
    } catch (e) {
      setStatus({ kind: "error", message: (e as Error).message });
    }
  };

  const saveRef = useRef(save);
  saveRef.current = save;
  const buildRef = useRef(build);
  buildRef.current = build;

  if (!code.open) return null;
  const close = () => {
    if (dirtyPaths().length && !window.confirm("Discard the unsaved changes?")) return;
    useProjectsUi.getState().closeCode();
  };
  const dirty = dirtyPaths();
  const errors = diags.current.filter((d) => d.severity === "error");
  const warnings = diags.current.filter((d) => d.severity === "warning");

  return (
    <div className="code-drawer" role="dialog" aria-label="Code editor" data-testid="code-editor" data-status={status.kind} data-editable={editable ? "true" : "false"}>
      <header className="code-head">
        <FileCode2 size={16} strokeWidth={STROKE} aria-hidden />
        <div className="code-title">
          <span>{snapshot ? `Version ${snapshot.version}` : projectName}</span>
          <span className="muted mono">{path ?? ""}</span>
        </div>
        <div className="code-actions">
          {editable ? (
            <>
              <button type="button" className="pj-btn" onClick={() => void save()} disabled={!dirty.length || status.kind === "saving" || status.kind === "building"} data-testid="code-save" title="Save (⌘S)">
                <Save size={15} strokeWidth={STROKE} aria-hidden /> Save
              </button>
              <button type="button" className="pj-btn pj-btn-primary" onClick={() => void build()} disabled={status.kind === "building" || status.kind === "saving" || !files.length} data-testid="code-build" title="Build & Run (⌘↵)">
                {status.kind === "building" ? <Loader2 size={15} strokeWidth={STROKE} className="spin" aria-hidden /> : <Play size={15} strokeWidth={STROKE} aria-hidden />} Build &amp; Run
              </button>
            </>
          ) : (
            <span className="code-ro" data-testid="code-readonly">
              <Lock size={13} strokeWidth={STROKE} aria-hidden /> Read-only
            </span>
          )}
          <button type="button" className="icon-btn" aria-label="Close the code editor" onClick={close} data-testid="code-close">
            <X size={18} strokeWidth={STROKE} aria-hidden />
          </button>
        </div>
      </header>
      {files.length > 1 ? (
        <nav className="code-tabs" aria-label="Files">
          {files.map((f) => {
            const b = buffers.current.get(f);
            return (
              <button key={f} type="button" className={`code-tab${f === path ? " is-active" : ""}`} onClick={() => setPath(f)} data-testid={`code-tab-${f}`} title={f}>
                {f.split("/").pop()}
                {b && b.text !== b.saved ? <span className="code-dot" aria-label="unsaved" /> : null}
              </button>
            );
          })}
        </nav>
      ) : null}
      {!editable ? (
        <p className="code-banner">
          {snapshot
            ? `The code as it was at version ${snapshot.version}. To edit it, restore that version in History.`
            : server === "no"
              ? `${NO_SERVER.replace("This needs", "Editing and building need")}`
              : "Loading…"}
        </p>
      ) : null}
      {loadError ? (
        <p className="code-banner code-banner-error" role="alert">
          {loadError}
        </p>
      ) : null}
      {source && !files.length && !loadError ? (
        <p className="code-banner" data-testid="code-no-files">
          {source === "server" ? "No sketch yet. Ask your agent to write one, or create firmware/main.ino:" : "No code to show: this canvas has no sketch."}
          {source === "server" ? (
            <button
              type="button"
              className="pj-btn"
              onClick={() => {
                buffers.current.set("firmware/main.ino", { saved: "", text: "void setup() {\n  Serial.begin(115200);\n}\n\nvoid loop() {\n}\n" });
                setFiles(["firmware/main.ino"]);
                setPath("firmware/main.ino");
              }}
            >
              New sketch
            </button>
          ) : null}
        </p>
      ) : null}
      <div className="code-body" ref={host} />
      <footer className="code-status" data-testid="code-status">
        {editable ? <StatusLine status={status} dirty={dirty.length} errors={errors.length} warnings={warnings.length} /> : <span className="muted">{files.length ? `${files.length} file${files.length === 1 ? "" : "s"}` : ""}</span>}
        {diags.current.length ? (
          <ul className="code-problems" data-testid="code-problems">
            {diags.current.slice(0, 12).map((d, i) => (
              <li key={i} data-severity={d.severity}>
                <button
                  type="button"
                  onClick={() => {
                    if (!d.file) return;
                    const target = files.find((f) => f === d.file || f.endsWith(d.file!)) ?? d.file;
                    if (target !== path) setPath(target);
                    setTimeout(() => d.line && editor.current?.goto(d.line, d.column), 30);
                  }}
                >
                  <AlertTriangle size={13} strokeWidth={STROKE} aria-hidden />
                  <span className="mono">
                    {d.file ? `${d.file.split("/").pop()}:${d.line ?? "?"}` : "build"}
                  </span>
                  <span>{d.message}</span>
                  {d.hint ? <span className="muted">Fix: {d.hint}</span> : null}
                </button>
              </li>
            ))}
          </ul>
        ) : null}
      </footer>
    </div>
  );
}

function StatusLine({ status, dirty, errors, warnings }: { status: Status; dirty: number; errors: number; warnings: number }) {
  switch (status.kind) {
    case "saving":
      return <span>Saving…</span>;
    case "building":
      return (
        <span>
          <Loader2 size={13} strokeWidth={STROKE} className="spin" aria-hidden /> Building with arduino-cli (first builds take a while)…
        </span>
      );
    case "built":
      return (
        <span className="code-ok">
          <CircleCheck size={13} strokeWidth={STROKE} aria-hidden /> Built{status.res.cached ? " (cached)" : ""}
          {status.res.size ? ` · ${status.res.size}` : ""}
          {warnings ? ` · ${warnings} warning${warnings === 1 ? "" : "s"}` : ""}
          {status.res.run ? (status.res.run.error ? ` · run failed: ${status.res.run.error}` : " · running on the canvas") : ""}
        </span>
      );
    case "failed":
      return (
        <span className="code-bad">
          <AlertTriangle size={13} strokeWidth={STROKE} aria-hidden /> Build failed: {errors ? `${errors} error${errors === 1 ? "" : "s"}, shown at their lines` : (status.res.error ?? status.res.log ?? "no details")}
        </span>
      );
    case "error":
      return (
        <span className="code-bad" role="alert">
          {status.message}
        </span>
      );
    case "saved":
      return <span>{dirty ? `${dirty} unsaved file${dirty === 1 ? "" : "s"}` : "Saved. Build & Run compiles it and runs it on the canvas."}</span>;
    default:
      return <span className="muted">{dirty ? `${dirty} unsaved file${dirty === 1 ? "" : "s"} · ⌘S saves, ⌘↵ builds and runs` : "⌘S saves · ⌘↵ builds and runs"}</span>;
  }
}
