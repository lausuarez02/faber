import { EditorState, Compartment, type Extension } from "@codemirror/state";
import { EditorView, keymap } from "@codemirror/view";
import { basicSetup } from "codemirror";
import { cpp } from "@codemirror/lang-cpp";
import { python } from "@codemirror/lang-python";
import { lintGutter, setDiagnostics, type Diagnostic } from "@codemirror/lint";
import { syntaxHighlighting } from "@codemirror/language";
import { classHighlighter } from "@lezer/highlight";

/**
 * CodeMirror 6 (MIT) for Arduino sketches: C++ highlighting through stable `tok-*` classes (styled
 * from the app's tokens in code.css, so light and dark both work), a lint gutter for compile
 * errors, and Mod-S / Mod-Enter for save and build.
 */

export interface CompileDiagnostic {
  severity: "error" | "warning" | "note";
  file?: string;
  line?: number;
  column?: number;
  message: string;
  hint?: string;
}

const theme = EditorView.theme({
  "&": { height: "100%", fontSize: "12.5px", backgroundColor: "var(--bg-canvas)", color: "var(--fg)" },
  ".cm-scroller": { fontFamily: "var(--font-mono)", lineHeight: "1.55" },
  ".cm-content": { caretColor: "var(--fg)", padding: "10px 0" },
  ".cm-gutters": { backgroundColor: "var(--bg-canvas)", color: "var(--fg-faint)", border: "none" },
  ".cm-activeLine": { backgroundColor: "color-mix(in srgb, var(--fg) 4%, transparent)" },
  ".cm-activeLineGutter": { backgroundColor: "transparent", color: "var(--fg-muted)" },
  "&.cm-focused .cm-selectionBackground, .cm-selectionBackground, ::selection": { backgroundColor: "color-mix(in srgb, var(--data) 28%, transparent) !important" },
  ".cm-cursor": { borderLeftColor: "var(--fg)" },
  ".cm-tooltip": { backgroundColor: "var(--bg-float)", border: "1px solid var(--border-strong)", borderRadius: "8px", color: "var(--fg)" },
  ".cm-diagnostic": { fontFamily: "var(--font-ui)", fontSize: "12.5px", padding: "6px 10px", maxWidth: "520px" },
  ".cm-diagnostic-error": { borderLeft: "3px solid var(--error)" },
  ".cm-diagnostic-warning": { borderLeft: "3px solid var(--warn)" },
  ".cm-lintRange-error": { backgroundImage: "none", textDecoration: "underline wavy var(--error)", textUnderlineOffset: "3px" },
  ".cm-lintRange-warning": { backgroundImage: "none", textDecoration: "underline wavy var(--warn)", textUnderlineOffset: "3px" },
  ".cm-panels": { backgroundColor: "var(--bg-float)", color: "var(--fg)" },
  ".cm-searchMatch": { backgroundColor: "color-mix(in srgb, var(--warn) 30%, transparent)" },
  ".cm-foldPlaceholder": { backgroundColor: "var(--bg-raised)", border: "1px solid var(--border)", color: "var(--fg-muted)" },
});

/**
 * Round 10 (languages): the editor mode for a file, from its name. Python for MicroPython (.py),
 * C / C++ for Arduino, ESP-IDF and PlatformIO sources, plain text for the rest (platformio.ini,
 * CMakeLists.txt, sdkconfig.defaults).
 */
export type EditorMode = "python" | "cpp" | "text";
export function modeFor(path: string | undefined): EditorMode {
  if (!path) return "cpp";
  if (/\.py$/i.test(path)) return "python";
  if (/\.(ino|pde|c|cc|cpp|cxx|h|hh|hpp|S)$/i.test(path)) return "cpp";
  return "text";
}

export interface CodeEditorHandle {
  view: EditorView;
  /** `path` picks the language mode (modeFor). */
  setDoc(text: string, readOnly: boolean, path?: string): void;
  setDiagnostics(diags: CompileDiagnostic[]): void;
  goto(line: number, column?: number): void;
  destroy(): void;
}

export function createEditor(parent: HTMLElement, opts: { onChange(text: string): void; onSave(): void; onBuild(): void }): CodeEditorHandle {
  const readOnly = new Compartment();
  const extensions = (ro: boolean, mode: EditorMode = "cpp"): Extension[] => [
    keymap.of([
      { key: "Mod-s", preventDefault: true, run: () => (opts.onSave(), true) },
      { key: "Mod-Enter", preventDefault: true, run: () => (opts.onBuild(), true) },
    ]),
    basicSetup,
    mode === "python" ? python() : mode === "cpp" ? cpp() : [],
    syntaxHighlighting(classHighlighter),
    lintGutter(),
    theme,
    readOnly.of([EditorState.readOnly.of(ro), EditorView.editable.of(!ro)]),
    EditorView.updateListener.of((u) => {
      if (u.docChanged) opts.onChange(u.state.doc.toString());
    }),
    EditorView.contentAttributes.of({ "aria-label": mode === "python" ? "Python source" : "Sketch source", "data-testid": "code-content", "data-mode": mode }),
  ];
  const view = new EditorView({ parent, state: EditorState.create({ doc: "", extensions: extensions(true) }) });
  return {
    view,
    setDoc(text, ro, path) {
      view.setState(EditorState.create({ doc: text, extensions: extensions(ro, modeFor(path)) }));
    },
    setDiagnostics(diags) {
      const doc = view.state.doc;
      const out: Diagnostic[] = [];
      for (const d of diags) {
        const lineNo = Math.min(Math.max(1, d.line ?? 1), doc.lines);
        const line = doc.line(lineNo);
        const from = Math.min(line.to, line.from + Math.max(0, (d.column ?? 1) - 1));
        // Underline the token at the column (or the whole line when there is no column).
        const rest = line.text.slice(from - line.from);
        const word = d.column ? (/^[\w.]+|^\S/.exec(rest)?.[0].length ?? 1) : line.length;
        out.push({ from, to: Math.min(line.to, from + Math.max(1, word)), severity: d.severity === "note" ? "info" : d.severity, message: d.hint ? `${d.message}\nFix: ${d.hint}` : d.message, source: "arduino-cli" });
      }
      view.dispatch(setDiagnostics(view.state, out));
    },
    goto(line, column) {
      const doc = view.state.doc;
      const l = doc.line(Math.min(Math.max(1, line), doc.lines));
      const pos = Math.min(l.to, l.from + Math.max(0, (column ?? 1) - 1));
      view.dispatch({ selection: { anchor: pos }, effects: EditorView.scrollIntoView(pos, { y: "center" }) });
      view.focus();
    },
    destroy: () => view.destroy(),
  };
}
