/** Jumper mark: a jumper wire bent into a "J", a dupont pin at each tip. */
export function LogoMark({ size = 28 }: { size?: number }) {
  return (
    <svg className="logo-mark" width={size * 0.8} height={size} viewBox="0 0 32 40" aria-hidden="true">
      {/* wire */}
      <path
        d="M21 10 V26 a9 9 0 0 1 -18 0 V24"
        fill="none"
        stroke="var(--wire)"
        strokeWidth="4.2"
        strokeLinecap="round"
      />
      {/* top dupont housing + pin */}
      <rect x="17" y="1.5" width="8" height="10" rx="1.4" fill="var(--text)" />
      <rect x="18.6" y="3.4" width="4.8" height="1.4" rx="0.4" fill="var(--ink)" opacity="0.55" />
      <rect x="20.2" y="-2" width="1.6" height="4" rx="0.5" fill="var(--muted)" />
      {/* hook-end dupont housing + pin */}
      <rect x="-1" y="15" width="8" height="10" rx="1.4" fill="var(--text)" />
      <rect x="0.6" y="16.9" width="4.8" height="1.4" rx="0.4" fill="var(--ink)" opacity="0.55" />
      <rect x="2.2" y="11.5" width="1.6" height="4" rx="0.5" fill="var(--muted)" />
    </svg>
  );
}

export function Wordmark() {
  return (
    <span className="brand">
      <LogoMark />
      <span className="wordmark">Jumper</span>
    </span>
  );
}
