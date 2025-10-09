import React from "react";

/** Shared spinning circle (used by all loaders) */
function Spinner() {
  return (
    <div className="relative h-16 w-16">
      <svg viewBox="0 0 100 100" className="h-16 w-16 text-pool-400">
        <circle
          cx="50"
          cy="50"
          r="36"
          className="opacity-20"
          stroke="currentColor"
          strokeWidth="10"
          fill="none"
        />
        <circle
          cx="50"
          cy="50"
          r="36"
          stroke="currentColor"
          strokeWidth="10"
          fill="none"
          strokeDasharray="180 300"
          className="animate-spin origin-center"
          style={{ transformOrigin: "50% 50%" }}
        />
      </svg>
    </div>
  );
}

/** Base overlay wrapper */
function Overlay({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div
      className="fixed inset-0 z-[100] grid place-items-center bg-slate-950/70 backdrop-blur-sm"
      role="status"
      aria-live="polite"
      aria-busy="true"
      aria-label={label}
    >
      <div className="w-[min(92vw,520px)] rounded-2xl border border-slate-700 bg-slate-900/90 shadow-xl p-6 text-center">
        {children}
      </div>
    </div>
  );
}

/** Standard loading screen (fetching guards, setup, etc.) */
export function StandardLoading() {
  return (
    <Overlay label="Loading">
      <div className="flex flex-col items-center gap-4">
        <Spinner />
        <div className="text-lg font-semibold text-slate-100">Loading…</div>
      </div>
    </Overlay>
  );
}

/** Rotation loading (advancing +15 minutes) */
export function RotationLoading() {
  return (
    <Overlay label="Rotating positions">
      <div className="flex flex-col items-center gap-4">
        <Spinner />
        <div className="text-lg font-semibold text-slate-100">
          Rotating +15 min…
        </div>
      </div>
    </Overlay>
  );
}

/** Autofill loading (autopopulate seats) */
export function AutofillLoading() {
  return (
    <Overlay label="Autofilling seats">
      <div className="flex flex-col items-center gap-4">
        <Spinner />
        <div className="text-lg font-semibold text-slate-100">
          Autofilling seats…
        </div>
      </div>
    </Overlay>
  );
}
