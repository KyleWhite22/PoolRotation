export default function ToolbarActions({
  onPlus15, onAuto, onNewGuard, onRefresh, disabled, stamp
}: {
  onPlus15: () => void; onAuto: () => void; onNewGuard: () => void; onRefresh: () => void;
  disabled?: boolean; stamp?: string;
}) {
  return (
    <section className="flex flex-wrap gap-3 mb-6">
      <button onClick={onAuto} className="px-4 py-2 rounded-xl2 bg-pool-500 hover:bg-pool-400">AUTOFILL</button>
      <button onClick={onRefresh} className="px-4 py-2 rounded-xl2 bg-pool-600 hover:bg-pool-500">Reset All</button>
      {stamp && <span className="ml-auto text-xs rounded px-2 py-1 border border-pool-600">{stamp}</span>}
    </section>
  );
}
