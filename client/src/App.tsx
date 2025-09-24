import AppShell from "./AppShell";

export default function App() {
  return (
    <AppShell>
      <div className="rounded-xl2 bg-pool-700/40 p-6 shadow-soft">
        <p className="text-pool-100">
          Welcome! This is your app shell. Future components (dashboard,
          schedules, guard lists) will render here inside the shell.
        </p>
      </div>
    </AppShell>
  );
}
