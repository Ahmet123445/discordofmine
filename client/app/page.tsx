import Link from "next/link";

export default function Home() {
  return (
    <main className="flex min-h-screen flex-col bg-[#111111] text-white selection:bg-indigo-500 selection:text-white">
      {/* Navigation */}
      <nav className="flex items-center justify-between px-6 py-6 max-w-7xl mx-auto w-full">
        <div className="flex items-center gap-2 font-bold text-xl tracking-tight">
          <div className="w-8 h-8 bg-indigo-500 rounded-lg flex items-center justify-center">
            <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="text-white"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>
          </div>
          <span>DiscordOfMine</span>
        </div>
        <div className="flex gap-4">
          <Link 
            href="/login" 
            className="px-5 py-2.5 rounded-full bg-white/10 hover:bg-white/20 transition-all font-medium text-sm"
          >
            Login
          </Link>
          <Link 
            href="/login" 
            className="px-5 py-2.5 rounded-full bg-indigo-600 hover:bg-indigo-500 hover:shadow-lg hover:shadow-indigo-500/20 transition-all font-medium text-sm"
          >
            Sign Up
          </Link>
        </div>
      </nav>

      {/* Hero Section */}
      <section className="flex-1 flex flex-col items-center justify-center px-4 text-center mt-10 mb-20">
        <div className="inline-flex items-center gap-2 px-3 py-1 rounded-full bg-indigo-900/30 text-indigo-400 text-xs font-medium mb-8 border border-indigo-500/20">
          <span className="relative flex h-2 w-2">
            <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-indigo-400 opacity-75"></span>
            <span className="relative inline-flex rounded-full h-2 w-2 bg-indigo-500"></span>
          </span>
          v1.0 is Live
        </div>

        <h1 className="text-5xl md:text-7xl font-black tracking-tighter mb-6 max-w-4xl bg-gradient-to-br from-white via-white to-zinc-500 bg-clip-text text-transparent">
          Imagine a place... <br/>
          <span className="text-indigo-500">without distractions.</span>
        </h1>
        
        <p className="text-zinc-400 text-lg md:text-xl max-w-2xl mb-10 leading-relaxed">
          A minimal, private communication tool built for your inner circle. 
          No algorithms, no tracking, just you and your friends.
        </p>

        <div className="flex flex-col sm:flex-row gap-4 w-full justify-center">
          <Link 
            href="/login" 
            className="px-8 py-4 rounded-full bg-indigo-600 hover:bg-indigo-500 hover:scale-105 transition-all font-bold text-lg shadow-xl shadow-indigo-900/20 flex items-center justify-center gap-2"
          >
            <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M15 3h4a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2h-4"/><polyline points="10 17 15 12 10 7"/><line x1="15" y1="12" x2="3" y2="12"/></svg>
            Open App in Browser
          </Link>
          <a 
            href="https://github.com/Ahmet123445/discordofmine" 
            target="_blank"
            className="px-8 py-4 rounded-full bg-zinc-800 hover:bg-zinc-700 hover:scale-105 transition-all font-bold text-lg border border-zinc-700 flex items-center justify-center gap-2"
          >
            <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M9 19c-5 1.5-5-2.5-7-3m14 6v-3.87a3.37 3.37 0 0 0-.94-2.61c3.14-.35 6.44-1.54 6.44-7A5.44 5.44 0 0 0 20 4.77 5.07 5.07 0 0 0 19.91 1S18.73.65 16 2.48a13.38 13.38 0 0 0-7 0C6.27.65 5.09 1 5.09 1A5.07 5.07 0 0 0 5 4.77a5.44 5.44 0 0 0-1.5 3.78c0 5.42 3.3 6.61 6.44 7A3.37 3.37 0 0 0 9 18.13V22"/></svg>
            View Source
          </a>
        </div>
      </section>

      {/* Feature Grid */}
      <section className="py-20 bg-zinc-900/50 border-t border-white/5">
        <div className="max-w-7xl mx-auto px-6">
          <div className="grid grid-cols-1 md:grid-cols-3 gap-8">
            <div className="p-8 rounded-2xl bg-zinc-900 border border-zinc-800 hover:border-indigo-500/30 transition-colors">
              <div className="w-12 h-12 bg-indigo-900/30 rounded-lg flex items-center justify-center mb-4 text-indigo-400">
                <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>
              </div>
              <h3 className="text-xl font-bold mb-2">Real-time Chat</h3>
              <p className="text-zinc-400">Instant messaging with persistence. File sharing, images, and emojis included.</p>
            </div>
            
            <div className="p-8 rounded-2xl bg-zinc-900 border border-zinc-800 hover:border-indigo-500/30 transition-colors">
              <div className="w-12 h-12 bg-indigo-900/30 rounded-lg flex items-center justify-center mb-4 text-indigo-400">
                <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z"/><path d="M19 10v2a7 7 0 0 1-14 0v-2"/><line x1="12" y1="19" x2="12" y2="23"/><line x1="8" y1="23" x2="16" y2="23"/></svg>
              </div>
              <h3 className="text-xl font-bold mb-2">Crystal Clear Voice</h3>
              <p className="text-zinc-400">Low-latency P2P voice chat with spatial audio features and volume control.</p>
            </div>

            <div className="p-8 rounded-2xl bg-zinc-900 border border-zinc-800 hover:border-indigo-500/30 transition-colors">
              <div className="w-12 h-12 bg-indigo-900/30 rounded-lg flex items-center justify-center mb-4 text-indigo-400">
                <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="2" y="3" width="20" height="14" rx="2" ry="2"/><line x1="8" y1="21" x2="16" y2="21"/><line x1="12" y1="17" x2="12" y2="21"/></svg>
              </div>
              <h3 className="text-xl font-bold mb-2">Screen Sharing</h3>
              <p className="text-zinc-400">Share your screen in high quality with a single click. Perfect for collaboration.</p>
            </div>
          </div>
        </div>
      </section>

      {/* Footer */}
      <footer className="py-10 text-center text-zinc-500 text-sm border-t border-white/5">
        <p>Built with Next.js, Socket.io, and WebRTC by Antigravity.</p>
      </footer>
    </main>
  );
}
