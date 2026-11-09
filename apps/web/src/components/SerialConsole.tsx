import { useCallback } from "react";
import { engine } from "../lib/app.ts";

/** The UART0 output. The engine writes into the <pre> directly and keeps the text while the panel is closed. */
export function SerialConsole() {
  const ref = useCallback((el: HTMLPreElement | null) => engine.registerConsole(el), []);
  return <pre ref={ref} className="console-out" data-testid="serial-console" aria-live="off" aria-label="Serial output" />;
}
