"use client";

import { useState, useEffect } from "react";
import { useRouter } from "next/navigation";
import GlowBackground from "@/components/GlowBackground";

export default function HomePage() {
  const router = useRouter();
  const [username, setUsername] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [tipIndex, setTipIndex] = useState(0);

  const tips = [
    "Ilk girisinde sunucuya baglanmak 30 sn surebilir",
    "Ucretsiz sunucu olustur, arkadaslarinla konus",
    "HD kalitesinde ekran paylasma ozelligi",
    "Guvenli ve sifreli sesli iletisim",
    "Sifresiz, hizli giris sistemi"
  ];

  useEffect(() => {
    // Check if already logged in
    const token = localStorage.getItem("token");
    if (token) {
      router.push("/rooms");
    }
  }, [router]);

  useEffect(() => {
    const interval = setInterval(() => {
      setTipIndex((prev) => (prev + 1) % tips.length);
    }, 4000);
    return () => clearInterval(interval);
  }, [tips.length]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError("");
    setLoading(true);

    const API_URL = process.env.NEXT_PUBLIC_API_URL || "http://localhost:3001";
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
      router.push("/rooms");
    } catch (err: any) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="relative w-full min-h-screen bg-black overflow-hidden flex items-center justify-center font-sans">
      {/* Animated Glow Background */}
      <GlowBackground />
      
      {/* Dark overlay for better readability */}
      <div className="absolute inset-0 bg-black/40 pointer-events-none" />

      <div className="relative z-10 w-full max-w-md p-8">
        <div className="text-center mb-10">
          {/* Main Title */}
          <h1 className="text-5xl md:text-6xl font-black tracking-tight text-white mb-4 drop-shadow-2xl">
            Sesli Sohbet
          </h1>
          
          {/* Tip Slider */}
          <div className="h-14 relative overflow-hidden">
            {tips.map((tip, idx) => (
              <div
                key={idx}
                className={`absolute inset-0 flex items-center justify-center transition-all duration-700 ease-in-out transform ${
                  idx === tipIndex 
                    ? "opacity-100 translate-y-0" 
                    : idx === (tipIndex - 1 + tips.length) % tips.length
                    ? "opacity-0 -translate-y-6"
                    : "opacity-0 translate-y-6"
                }`}
              >
                <div className="inline-flex items-center gap-2 px-5 py-2.5 rounded-full bg-white/10 backdrop-blur-md border border-white/20 shadow-xl">
                  <span className="text-sm text-zinc-200 font-medium">
                    {tip}
                  </span>
                </div>
              </div>
            ))}
          </div>
        </div>

        {error && (
          <div className="bg-red-500/20 backdrop-blur-md text-red-300 p-4 rounded-2xl mb-6 text-sm border border-red-500/30 text-center">
            {error}
          </div>
        )}

        <form onSubmit={handleSubmit} className="flex flex-col items-center gap-5">
          <div className="w-full relative group">
            <div className="absolute -inset-1 bg-gradient-to-r from-purple-600 via-pink-500 to-blue-500 rounded-2xl opacity-60 group-hover:opacity-100 transition duration-300 blur-lg"></div>
            <input
              type="text"
              required
              placeholder="Kullanici adi girin"
              className="relative w-full bg-black/80 text-white rounded-2xl px-6 py-4 text-center text-lg placeholder-zinc-500 focus:outline-none focus:ring-2 focus:ring-purple-500/50 transition-all border border-white/10 backdrop-blur-sm"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
            />
          </div>

          <button
            type="submit"
            disabled={loading || !username.trim()}
            className="group relative w-full py-4 bg-gradient-to-r from-purple-600 to-pink-600 text-white font-bold rounded-2xl hover:from-purple-500 hover:to-pink-500 transition-all disabled:opacity-50 disabled:cursor-not-allowed active:scale-[0.98] shadow-xl shadow-purple-500/25"
          >
            <span className="relative z-10 text-lg">
              {loading ? "Baglaniyor..." : "Giris Yap"}
            </span>
          </button>
        </form>
        
        <div className="mt-10 text-center space-y-4">
          <div className="flex items-center justify-center gap-4 text-xs text-zinc-500">
            <span className="flex items-center gap-1.5">
              <div className="w-1.5 h-1.5 rounded-full bg-green-500 animate-pulse"></div>
              Sunucu aktif
            </span>
            <span>•</span>
            <span>Sifre gerektirmez</span>
            <span>•</span>
            <span>Ucretsiz</span>
          </div>
          
          <p className="text-[11px] text-zinc-600">
            kombogame.net
          </p>
        </div>
      </div>
    </div>
  );
}
