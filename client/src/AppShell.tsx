import type { ReactNode } from "react";

export default function AppShell({ children }: { children: ReactNode }) {
  return (
    <div className="min-h-screen flex flex-col bg-pool-800 text-white">
      {/* Top Navbar */}
      <header className="h-16 flex items-center px-6 border-b border-pool-700 bg-pool-900">
        <h1 className="text-xl font-semibold"> Rotation Manager</h1>
      </header>

      {/* Main content area */}
      <main className="flex-1 p-6">{children}</main>

     
    </div>
  );
}
