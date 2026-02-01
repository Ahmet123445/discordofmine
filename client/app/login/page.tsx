"use client";

import { useState, useEffect } from "react";
import { useRouter } from "next/navigation";
import Hyperspeed from "@/components/Hyperspeed";

export default function LoginPage() {
  const router = useRouter();
  const [username, setUsername] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [tipIndex, setTipIndex] = useState(0);

  const tips = [
    "🚀 İlk girişinizde sunucuya bağlanmak 30 sn sürebilir.",
    "🎮 Ücretsiz sunucu oluştur, arkadaşlarınla konuş.",
    "📺 HD kalitesinde ekran paylaşma özelliği.",
    "🔒 Güvenli ve şifreli sesli iletişim.",
    "✨ Modern ve hızlı arayüz."
  ];

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
    <div className="relative w-full h-screen bg-black overflow-hidden flex items-center justify-center font-sans">
      <div className="absolute inset-0">
        <Hyperspeed 
          effectOptions={{
            onSpeedUp: () => {},
            onSlowDown: () => {},
            distortion: "turbulentDistortion",
            length: 400,
            roadWidth: 10,
            islandWidth: 2,
            lanesPerRoad: 4,
            fov: 90,
            fovSpeedUp: 150,
            speedUp: 2,
            carLightsFade: 0.4,
            totalSideLightSticks: 20,
            lightPairsPerRoadWay: 40,
            shoulderLinesWidthPercentage: 0.05,
            brokenLinesWidthPercentage: 0.1,
            brokenLinesLengthPercentage: 0.5,
            lightStickWidth: [0.12, 0.5],
            lightStickHeight: [1.3, 1.7],
            movingAwaySpeed: [60, 80],
            movingCloserSpeed: [-120, -160],
            carLightsLength: [400 * 0.03, 400 * 0.2],
            carLightsRadius: [0.05, 0.14],
            carWidthPercentage: [0.3, 0.5],
            carShiftX: [-0.8, 0.8],
            carFloorSeparation: [0, 5],
            colors: {
              roadColor: 0x080808,
              islandColor: 0x0a0a0a,
              background: 0x000000,
              shoulderLines: 0x131318,
              brokenLines: 0x131318,
              leftCars: [0xff102a, 0xEB383E, 0xff102a],
              rightCars: [0xdadafa, 0xd8888b, 0xdadafa],
              sticks: 0xdadafa,
            }
          }}
        />
      </div>

      <div className="relative z-10 w-full max-w-md p-8">
        <div className="text-center mb-12">
          <h1 className="text-4xl md:text-5xl font-extrabold tracking-tighter text-transparent bg-clip-text bg-gradient-to-br from-indigo-400 to-purple-600 mb-6 drop-shadow-2xl">
            Kombogame Sesli Sohbet
          </h1>
          
          {/* Tip Slider */}
          <div className="h-12 relative overflow-hidden">
            {tips.map((tip, idx) => (
              <div
                key={idx}
                className={`absolute inset-0 flex items-center justify-center transition-all duration-700 transform ${
                  idx === tipIndex 
                    ? "opacity-100 translate-y-0" 
                    : "opacity-0 translate-y-4"
                }`}
              >
                <div className="inline-flex items-center gap-2 px-4 py-2 rounded-full bg-white/5 backdrop-blur-md border border-white/10">
                  <span className="text-xs md:text-sm text-zinc-300 font-medium tracking-wide">
                    {tip}
                  </span>
                </div>
              </div>
            ))}
          </div>
        </div>

        {error && (
          <div className="bg-red-500/10 backdrop-blur-md text-red-400 p-3 rounded-xl mb-6 text-sm border border-red-500/20 text-center animate-pulse">
            {error}
          </div>
        )}

        <form onSubmit={handleSubmit} className="flex flex-col items-center gap-6">
          <div className="w-full relative group">
            <div className="absolute -inset-0.5 bg-gradient-to-r from-indigo-500 to-purple-600 rounded-xl opacity-75 group-hover:opacity-100 transition duration-200 blur animate-tilt"></div>
            <input
              type="text"
              required
              placeholder="Kullanıcı Adı Giriniz"
              className="relative w-full bg-black text-white rounded-xl px-6 py-4 text-center text-lg placeholder-zinc-600 focus:outline-none focus:ring-2 focus:ring-indigo-500/50 transition-all border border-zinc-800/50"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
            />
          </div>

          <button
            type="submit"
            disabled={loading}
            className="group relative px-8 py-3 bg-white text-black font-bold rounded-full hover:bg-zinc-200 transition-all disabled:opacity-50 disabled:cursor-not-allowed active:scale-95 w-full sm:w-auto overflow-hidden"
          >
            <span className="relative z-10">{loading ? "Bağlanıyor..." : "Giriş Yap"}</span>
            <div className="absolute inset-0 bg-gradient-to-r from-indigo-500/20 to-purple-500/20 opacity-0 group-hover:opacity-100 transition-opacity"></div>
            <div className="absolute inset-0 rounded-full ring-2 ring-white/50 group-hover:ring-4 transition-all opacity-0 group-hover:opacity-100"></div>
          </button>
        </form>
        
        <div className="mt-12 text-center">
             <p className="text-[10px] text-zinc-600">
               © 2024 Kombogame. Tüm hakları saklıdır.
             </p>
        </div>
      </div>
    </div>
  );
}
