import { Link, useLocation } from "react-router-dom";
import type { ReactNode } from "react";

export default function AppShell({
  children,
  title = "Lifeguard Rotation Manager",
  actions,
  subheader,
  footer,
}: {
  children: ReactNode;
  title?: string;
  actions?: ReactNode;
  subheader?: ReactNode;
  footer?: ReactNode;
}) {
  const location = useLocation();

  const navLink = (to: string, label: string) => {
    const active = location.pathname === to;
    return (
      <Link
        to={to}
        className={`px-2 py-1 rounded transition-colors ${
          active
            ? "bg-pool-600 text-white"
            : "hover:underline hover:text-pool-300 text-slate-200"
        }`}
      >
        {label}
      </Link>
    );
  };

  return (
    <div className="min-h-screen flex flex-col bg-pool-800 text-white">
      <header className="h-16 flex items-center px-6 border-b border-pool-700 bg-pool-900">
        {/* Left: Logo + Title */}
        <div className="flex items-center gap-3">
          <img src="/hilliardLogoWhite.svg" alt="Pool Logo" className="h-10 w-10 object-contain" />
          <h1 className="text-xl font-semibold">{title}</h1>
        </div>

        {/* Center: Navigation links */}
        <nav className="ml-8 flex items-center gap-4 text-sm">
          {navLink("/", "Home")}
          {navLink("/guards", "Guard Manager")}
        </nav>

        {/* Right: Actions passed from the page */}
        {actions && <div className="ml-auto flex items-center gap-2">{actions}</div>}
      </header>

      {subheader && (
        <div className="h-10 flex items-center px-6 border-b border-pool-700 bg-pool-900/80">
          {subheader}
        </div>
      )}

      <main className="flex-1 p-6">{children}</main>

      {footer ? (
        <footer className="border-t border-pool-700 bg-pool-900/60">
          <div className="w-full mx-auto max-w-7xl p-4">{footer}</div>
        </footer>
      ) : null}
    </div>
  );
}
