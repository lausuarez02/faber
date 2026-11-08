import { useJumper } from "../lib/app.ts";
import { Icon } from "./Icon.tsx";

export function Toasts() {
  const toasts = useJumper((s) => s.toasts);
  return (
    <div className="toasts" aria-live="polite">
      {toasts.map((t) => (
        <div key={t.id} className={`toast toast-${t.kind}`} role={t.kind === "error" ? "alert" : "status"}>
          <div className="toast-text">
            <strong>{t.title}</strong>
            {t.detail && <pre>{t.detail}</pre>}
          </div>
          <button className="btn btn-icon btn-small" aria-label="Dismiss" onClick={() => useJumper.getState().dismissToast(t.id)}>
            <Icon name="close" size={14} />
          </button>
        </div>
      ))}
    </div>
  );
}
