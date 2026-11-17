import { useCallback, useEffect, useState, useSyncExternalStore } from "react";
import { ArrowDown, CornerDownLeft, Search, X } from "lucide-react";
import { engine, useFaber } from "../lib/app.ts";
import { onProjectSwitch } from "../lib/projectSwitch.ts";
import "./canvas.css";

/**
 * The UART0 / USB serial output. The engine writes into the <pre> directly and keeps the text while
 * the panel is closed. Round 6: it follows the newest line unless the person scrolled up to read;
 * then a "Newest" button jumps back and follows again. Round 6b: a filter box shows only the lines
 * with the words typed, or hides lines with "-word" (the whole output is kept; clearing the box
 * shows it all again).
 */
export function SerialConsole() {
  const ref = useCallback((el: HTMLPreElement | null) => engine.registerConsole(el), []);
  const following = useSyncExternalStore(engine.subscribeSerialFollow, engine.getSerialFollowing, engine.getSerialFollowing);
  const [query, setQuery] = useState(() => engine.serialFilterText);
  const apply = (q: string) => {
    setQuery(q);
    engine.setSerialFilter(q);
  };
  // Round 10: a line typed here goes to the board (the MicroPython REPL, or Serial.read() in a sketch).
  const [line, setLine] = useState("");
  const [sendNote, setSendNote] = useState<string | undefined>();
  const micropython = useFaber((s) => s.project.firmware?.language === "micropython" || !!s.project.firmware?.sketch?.endsWith(".py"));
  const send = (text: string) => {
    if (engine.sendSerial(text)) setSendNote(undefined);
    else setSendNote("Not sent: nothing is running on this page. Press Run first (while following an agent, Run here starts the device in this page).");
  };
  // Another project: its serial starts unfiltered.
  useEffect(() => onProjectSwitch(({ reason }) => reason === "open" && apply("")), []);
  return (
    <>
      <div className="serial-filter">
        <Search size={13} strokeWidth={2} aria-hidden className="serial-filter-icon" />
        <input
          type="search"
          value={query}
          onChange={(e) => apply(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Escape" && query) {
              e.stopPropagation();
              apply("");
            }
          }}
          placeholder="Filter lines (-word hides)"
          aria-label="Filter the serial lines: words to show, or -word to hide"
          data-testid="serial-filter"
          spellCheck={false}
        />
        {query ? (
          <button type="button" className="icon-btn icon-btn-sm" aria-label="Show every line" title="Show every line" onClick={() => apply("")}>
            <X size={12} strokeWidth={2} aria-hidden />
          </button>
        ) : null}
      </div>
      <pre ref={ref} className="console-out" data-testid="serial-console" data-following={following} data-filtered={query.trim() ? "true" : undefined} aria-live="off" aria-label="Serial output" />
      <form
        className="serial-send"
        onSubmit={(e) => {
          e.preventDefault();
          // MicroPython's REPL takes CR as Enter; sketches usually read up to '\n'.
          send(line + (micropython ? "\r" : "\n"));
          setLine("");
        }}
      >
        <input
          type="text"
          value={line}
          onChange={(e) => setLine(e.target.value)}
          onKeyDown={(e) => {
            if (e.ctrlKey && (e.key === "c" || e.key === "d") && !line) {
              e.preventDefault();
              send(e.key === "c" ? "\x03" : "\x04");
            }
          }}
          placeholder={micropython ? ">>> type Python, Enter runs it (Ctrl-C stops main.py)" : "Send to the board (Enter)"}
          aria-label="Send a line to the board's serial port"
          data-testid="serial-input"
          spellCheck={false}
          autoCapitalize="off"
          autoComplete="off"
        />
        <button type="submit" className="icon-btn icon-btn-sm" aria-label="Send" title="Send (Enter)" data-testid="serial-send">
          <CornerDownLeft size={13} strokeWidth={2} aria-hidden />
        </button>
      </form>
      {sendNote ? (
        <p className="serial-send-note" role="status" data-testid="serial-send-note">
          {sendNote}
        </p>
      ) : null}
      {following ? null : (
        <button type="button" className="serial-newest" data-testid="serial-newest" onClick={() => engine.followSerial()}>
          <ArrowDown size={12} strokeWidth={2} aria-hidden /> Newest
        </button>
      )}
    </>
  );
}
