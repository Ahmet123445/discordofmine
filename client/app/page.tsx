"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import GridScan from "@/components/GridScan";

export default function Home() {
  const router = useRouter();
  const [username, setUsername] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError("");
    setLoading(true);

    const API_URL = process.env.NEXT_PUBLIC_API_URL || "http://localhost:3001";
    // Always call login, backend handles creation if needed
    const endpoint = `${API_URL}/api/auth/login`;

    try {
      const res = await fetch(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username }),
      });

      const data = await res.json();

      if (!res.ok) {
        throw new Error(data.error || "Something went wrong");
      }

      localStorage.setItem("token", data.token);
      localStorage.setItem("user", JSON.stringify(data.user));
      // Redirect to rooms selection
      router.push("/rooms");
    } catch (err: any) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="relative w-full h-screen bg-black overflow-hidden flex items-center justify-center font-sans">
      <div className="absolute inset-0">
        <GridScan
          sensitivity={0.55}
          lineThickness={1}
          linesColor="#392e4e"
          gridScale={0.1}
          scanColor="#FF9FFC"
          scanOpacity={0.4}
          enablePost
          bloomIntensity={0.6}
          chromaticAberration={0.002}
          noiseIntensity={0.01}
        />
      </div>

      <div className="relative z-10 w-full max-w-md p-8">
        <div className="text-center mb-12">
          <h1 className="text-5xl font-extrabold tracking-tighter text-white mb-4 drop-shadow-xl">
            V A T A N A S K I
          </h1>
          <p className="text-zinc-400 text-sm tracking-wide uppercase">
            Private Communication Network
          </p>
        </div>

        {error && (
          <div className="bg-red-500/10 backdrop-blur-md text-red-400 p-3 rounded-xl mb-6 text-sm border border-red-500/20 text-center">
            {error}
          </div>
        )}

        <form onSubmit={handleSubmit} className="flex flex-col items-center gap-6">
          <div className="w-full relative group">
            <div className="absolute -inset-0.5 bg-gradient-to-r from-indigo-500 to-purple-600 rounded-xl opacity-75 group-hover:opacity-100 transition duration-200 blur"></div>
            <input
              type="text"
              required
              placeholder="Enter your username"
              className="relative w-full bg-black text-white rounded-xl px-6 py-4 text-center text-lg placeholder-zinc-600 focus:outline-none focus:ring-2 focus:ring-indigo-500/50 transition-all border border-zinc-800/50"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
            />
          </div>

          <button
            type="submit"
            disabled={loading}
            className="group relative px-8 py-3 bg-white text-black font-bold rounded-full hover:bg-zinc-200 transition-all disabled:opacity-50 disabled:cursor-not-allowed active:scale-95 w-full sm:w-auto"
          >
            {loading ? "Connecting..." : "Connect"}
            <div className="absolute inset-0 rounded-full ring-2 ring-white/50 group-hover:ring-4 transition-all opacity-0 group-hover:opacity-100"></div>
          </button>
        </form>
        
        <div className="mt-12 text-center">
             <div className="inline-block px-4 py-2 rounded-full bg-white/5 backdrop-blur-sm border border-white/10 text-xs text-zinc-500">
               No password required • Secure • Fast
             </div>
        </div>
      </div>
    </div>
  );
}
