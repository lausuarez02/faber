import { useCallback, useEffect, useState, useSyncExternalStore } from "react";
import { ArrowDown, Search, X } from "lucide-react";
import { engine } from "../lib/app.ts";
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
      {following ? null : (
        <button type="button" className="serial-newest" data-testid="serial-newest" onClick={() => engine.followSerial()}>
          <ArrowDown size={12} strokeWidth={2} aria-hidden /> Newest
        </button>
      )}
    </>
  );
}
