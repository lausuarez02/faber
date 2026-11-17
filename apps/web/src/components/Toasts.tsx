import { CircleAlert, Info, X } from "lucide-react";
import { useFaber } from "../lib/app.ts";

export function Toasts() {
  const toasts = useFaber((s) => s.toasts);
  return (
    <div className="toasts" aria-live="polite">
      {toasts.map((t) => (
        <div key={t.id} className={`toast toast-${t.kind}`} data-testid="toast" data-kind={t.kind} role={t.kind === "error" ? "alert" : "status"}>
          {t.kind === "error" ? <CircleAlert size={16} strokeWidth={1.8} className="toast-icon" aria-hidden /> : <Info size={16} strokeWidth={1.8} className="toast-icon" aria-hidden />}
          <div className="toast-text">
            <strong>{t.title}</strong>
            {t.detail && <pre>{t.detail}</pre>}
          </div>
          <button type="button" className="icon-btn icon-btn-sm" aria-label="Dismiss" onClick={() => useFaber.getState().dismissToast(t.id)}>
            <X size={14} strokeWidth={1.6} aria-hidden />
          </button>
        </div>
      ))}
    </div>
  );
}
