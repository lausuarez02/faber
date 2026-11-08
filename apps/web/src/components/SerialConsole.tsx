import { useCallback } from "react";
import { engine } from "../lib/app.ts";
import { Icon } from "./Icon.tsx";

export function SerialConsole() {
  const ref = useCallback((el: HTMLPreElement | null) => engine.registerConsole(el), []);
  return (
    <section className="console" aria-label="Serial console">
      <div className="panel-head">
        <span className="eyebrow">Serial · UART0</span>
        <button
          className="btn btn-icon btn-small"
          aria-label="Clear console"
          title="Clear"
          onClick={() => engine.clearSerial()}
        >
          <Icon name="clear" size={16} />
        </button>
      </div>
      <pre ref={ref} className="console-out" data-testid="serial-console" aria-live="off" />
    </section>
  );
}
