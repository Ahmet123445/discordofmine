"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import SpotlightCard from "@/components/SpotlightCard";

interface Room {
  id: string;
  name: string;
}

export default function RoomsPage() {
  const router = useRouter();
  const [rooms, setRooms] = useState<Room[]>([]);
  const [loading, setLoading] = useState(true);
  const [showCreateModal, setShowCreateModal] = useState(false);
  const [newRoomName, setNewRoomName] = useState("");
  const [isCreating, setIsCreating] = useState(false);

  useEffect(() => {
    const token = localStorage.getItem("token");
    if (!token) {
      router.push("/login");
      return;
    }
    fetchRooms();
  }, [router]);

  const fetchRooms = async () => {
    try {
      const API_URL = process.env.NEXT_PUBLIC_API_URL || "http://localhost:3001";
      const res = await fetch(`${API_URL}/api/rooms`);
      if (res.ok) {
        const data = await res.json();
        setRooms(data);
      }
    } catch (err) {
      console.error("Failed to fetch rooms", err);
    } finally {
      setLoading(false);
    }
  };

  const createRoom = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newRoomName.trim()) return;

    setIsCreating(true);
    try {
      const API_URL = process.env.NEXT_PUBLIC_API_URL || "http://localhost:3001";
      const user = JSON.parse(localStorage.getItem("user") || "{}");
      
      const res = await fetch(`${API_URL}/api/rooms`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: newRoomName, userId: user.id }),
      });

      if (res.ok) {
        await fetchRooms();
        setShowCreateModal(false);
        setNewRoomName("");
      }
    } catch (err) {
      console.error("Failed to create room", err);
    } finally {
      setIsCreating(false);
    }
  };

  const handleRoomClick = (roomId: string) => {
    router.push(`/chat?roomId=${roomId}`);
  };

  if (loading) {
    return (
      <div className="min-h-screen bg-black flex items-center justify-center text-white">
        Loading...
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-black text-white p-8">
      <div className="max-w-6xl mx-auto">
        <header className="mb-12 flex items-center justify-between">
          <div>
            <h1 className="text-3xl font-bold bg-gradient-to-r from-indigo-500 to-purple-500 bg-clip-text text-transparent">
              Sunucular
            </h1>
            <p className="text-zinc-500 mt-1">Katilmak istedigin odayi sec veya yeni bir tane olustur.</p>
          </div>
          <button 
            onClick={() => {
              localStorage.clear();
              router.push("/login");
            }}
            className="text-sm text-zinc-500 hover:text-red-400 transition-colors"
          >
            Cikis Yap
          </button>
        </header>

        <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-6">
          {/* Create Room Card */}
          <SpotlightCard 
            className="h-48 flex items-center justify-center cursor-pointer border-dashed border-2 border-zinc-800 hover:border-zinc-600 bg-transparent group"
            spotlightColor="rgba(255, 255, 255, 0.1)"
            onClick={() => setShowCreateModal(true)}
          >
            <div className="flex flex-col items-center gap-3">
              <div className="w-12 h-12 rounded-full bg-zinc-900 flex items-center justify-center group-hover:bg-zinc-800 transition-colors">
                <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="text-zinc-400 group-hover:text-white"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
              </div>
              <span className="font-medium text-zinc-400 group-hover:text-white transition-colors">Oda Olustur</span>
            </div>
          </SpotlightCard>

          {/* Room Cards */}
          {rooms.map((room) => (
            <SpotlightCard 
              key={room.id}
              className="h-48 flex flex-col justify-between cursor-pointer"
              spotlightColor="rgba(99, 102, 241, 0.15)"
              onClick={() => handleRoomClick(room.id)}
            >
              <div>
                <div className="flex justify-between items-start mb-2">
                  <div className="w-10 h-10 rounded-lg bg-gradient-to-br from-indigo-600 to-purple-600 flex items-center justify-center text-lg font-bold shadow-lg shadow-indigo-900/20">
                    {room.name[0].toUpperCase()}
                  </div>
                  <div className="bg-green-500/10 text-green-400 text-[10px] px-2 py-1 rounded-full border border-green-500/20">
                    Online
                  </div>
                </div>
                <h3 className="text-xl font-bold text-white truncate">{room.name}</h3>
                <p className="text-xs text-zinc-500 mt-1">ID: {room.id.split('-')[0]}...</p>
              </div>
              
              <div className="mt-4 pt-4 border-t border-zinc-800 flex items-center justify-between">
                <span className="text-xs text-zinc-500">Ses & Chat</span>
                <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="text-zinc-600"><path d="M5 12h14"/><path d="M12 5l7 7-7 7"/></svg>
              </div>
            </SpotlightCard>
          ))}
        </div>
      </div>

      {/* Create Room Modal */}
      {showCreateModal && (
        <div className="fixed inset-0 bg-black/80 backdrop-blur-sm z-50 flex items-center justify-center p-4">
          <div className="bg-zinc-900 border border-zinc-800 rounded-2xl w-full max-w-md p-6 shadow-2xl">
            <h2 className="text-xl font-bold mb-4">Yeni Oda Olustur</h2>
            <form onSubmit={createRoom}>
              <input 
                type="text" 
                placeholder="Oda ismi..."
                autoFocus
                className="w-full bg-zinc-950 border border-zinc-700 rounded-xl p-3 text-white focus:outline-none focus:border-indigo-500 mb-4"
                value={newRoomName}
                onChange={(e) => setNewRoomName(e.target.value)}
              />
              <div className="flex gap-3 justify-end">
                <button 
                  type="button"
                  onClick={() => setShowCreateModal(false)}
                  className="px-4 py-2 rounded-lg text-zinc-400 hover:text-white hover:bg-zinc-800 transition-colors"
                >
                  Iptal
                </button>
                <button 
                  type="submit"
                  disabled={isCreating || !newRoomName.trim()}
                  className="px-4 py-2 bg-indigo-600 hover:bg-indigo-500 text-white rounded-lg disabled:opacity-50"
                >
                  {isCreating ? "Olusturuluyor..." : "Olustur"}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
