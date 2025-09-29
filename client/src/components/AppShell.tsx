import type { ReactNode } from "react";

export default function AppShell({
  children,
  title = "Lifeguard Rotation Manager",
  subheader,
  footer = "Designed by Kyle White",
}: {
  children: ReactNode;
  title?: string;
  subheader?: ReactNode;
  footer?: ReactNode;
}) {
  return (
    <div className="min-h-screen flex flex-col bg-pool-800 text-white">
      {/* Top Navbar */}
      <header className="h-16 flex items-center px-6 border-b border-pool-700 bg-pool-900">
        <div className="flex items-center gap-3">
          <img
            src="/hilliardLogoWhite.svg"
            alt="Pool Logo"
            className="h-16 w-16 object-contain"
          />
          <h1 className="text-xl font-semibold">{title}</h1>
        </div>
      </header>

      {subheader && (
        <div className="h-10 flex items-center px-6 border-b border-pool-700 bg-pool-900/80">
          {subheader}
        </div>
      )}

      {/* Main content area */}
      <main className="flex-1 p-6">{children}</main>

      {footer && (
        <footer>
          <div className="max-w-6xl mx-auto p-4 text-center text-sm text-gray-300">
            {footer}
          </div>
        </footer>
      )}
    </div>
  );
}
