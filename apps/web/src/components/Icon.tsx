const PATHS: Record<string, string> = {
  play: "M7 4.5v15l12-7.5z",
  pause: "M7 4.5h3.5v15H7zM13.5 4.5H17v15h-3.5z",
  reset: "M5 12a7 7 0 1 0 2.05-4.95M5 4v4h4",
  undo: "M9 14 4 9l5-5M4 9h10.5a5.5 5.5 0 0 1 0 11H11",
  redo: "m15 14 5-5-5-5M20 9H9.5a5.5 5.5 0 0 0 0 11H13",
  sun: "M12 7.5a4.5 4.5 0 1 0 0 9 4.5 4.5 0 0 0 0-9zM12 2v2.5M12 19.5V22M4.2 4.2 6 6M18 18l1.8 1.8M2 12h2.5M19.5 12H22M4.2 19.8 6 18M18 6l1.8-1.8",
  moon: "M20 14.5A8 8 0 0 1 9.5 4a8 8 0 1 0 10.5 10.5z",
  auto: "M12 3a9 9 0 1 0 0 18zM12 3a9 9 0 0 1 0 18",
  more: "M5 12h.01M12 12h.01M19 12h.01",
  download: "M12 4v11m0 0-4.5-4.5M12 15l4.5-4.5M5 20h14",
  upload: "M12 15V4m0 0L7.5 8.5M12 4l4.5 4.5M5 20h14",
  chip: "M8 8h8v8H8zM10 4v4M14 4v4M10 16v4M14 16v4M4 10h4M4 14h4M16 10h4M16 14h4",
  search: "m20 20-4.5-4.5M10.5 17a6.5 6.5 0 1 1 0-13 6.5 6.5 0 0 1 0 13z",
  parts: "M4 4h7v7H4zM13 4h7v7h-7zM4 13h7v7H4zM13 16.5h7M16.5 13v7",
  sliders: "M4 7h10M18 7h2M4 17h4M12 17h8M14 4.5v5M8 14.5v5",
  terminal: "m5 8 4 4-4 4M12 17h7",
  rotate: "M20 12a8 8 0 1 1-2.34-5.66M20 4v5h-5",
  trash: "M5 7h14M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3",
  close: "M6 6l12 12M18 6 6 18",
  clear: "M5 12h14",
};

export function Icon({ name, size = 18 }: { name: string; size?: number }) {
  return (
    <svg className="icon" width={size} height={size} viewBox="0 0 24 24" aria-hidden="true">
      <path d={PATHS[name] ?? ""} fill={name === "play" || name === "pause" ? "currentColor" : "none"} stroke="currentColor" strokeWidth={name === "more" ? 3.2 : 1.8} strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}
