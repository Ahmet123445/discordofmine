export default function Home() {
  return (
    <main className="flex min-h-screen flex-col items-center justify-center bg-zinc-900 text-zinc-100 p-4">
      <div className="text-center max-w-2xl">
        <h1 className="text-4xl font-bold mb-4 tracking-tight">DiscordOfMine</h1>
        <p className="text-zinc-400 mb-8">
          Private, lightweight communication for friends.
        </p>
        
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4 w-full">
          <div className="p-6 rounded-lg bg-zinc-800 border border-zinc-700">
            <h2 className="text-xl font-semibold mb-2">Client</h2>
            <p className="text-sm text-zinc-400">Next.js + Tailwind</p>
            <div className="mt-4 inline-flex items-center px-3 py-1 rounded-full bg-green-900/30 text-green-400 text-xs font-medium">
              Ready
            </div>
          </div>

          <div className="p-6 rounded-lg bg-zinc-800 border border-zinc-700">
            <h2 className="text-xl font-semibold mb-2">Server</h2>
            <p className="text-sm text-zinc-400">Express + Socket.io</p>
            <div className="mt-4 inline-flex items-center px-3 py-1 rounded-full bg-green-900/30 text-green-400 text-xs font-medium">
              Ready
            </div>
          </div>
        </div>
      </div>
    </main>
  );
}
