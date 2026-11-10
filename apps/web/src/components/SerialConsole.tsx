import { useCallback, useSyncExternalStore } from "react";
import { ArrowDown } from "lucide-react";
import { engine } from "../lib/app.ts";
import "./canvas.css";

/**
 * The UART0 / USB serial output. The engine writes into the <pre> directly and keeps the text while
 * the panel is closed. Round 6: it follows the newest line unless the person scrolled up to read;
 * then a "Newest" button jumps back and follows again.
 */
export function SerialConsole() {
  const ref = useCallback((el: HTMLPreElement | null) => engine.registerConsole(el), []);
  const following = useSyncExternalStore(engine.subscribeSerialFollow, engine.getSerialFollowing, engine.getSerialFollowing);
  return (
    <>
      <pre ref={ref} className="console-out" data-testid="serial-console" data-following={following} aria-live="off" aria-label="Serial output" />
      {following ? null : (
        <button type="button" className="serial-newest" data-testid="serial-newest" onClick={() => engine.followSerial()}>
          <ArrowDown size={12} strokeWidth={2} aria-hidden /> Newest
        </button>
      )}
    </>
  );
}
