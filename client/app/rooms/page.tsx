"use client";

import { useEffect, useState, useRef } from "react";
import { useRouter } from "next/navigation";
import MagicCard from "@/components/MagicCard";
import Particles from "@/components/Particles";
import { io, Socket } from "socket.io-client";

interface Room {
  id: string;
  name: string;
  onlineCount: number;
  users: string[];
  isPrivate: boolean;
  created_at?: string;
}

export default function RoomsPage() {
  const router = useRouter();
  const [rooms, setRooms] = useState<Room[]>([]);
  const [loading, setLoading] = useState(true);
  
  // Create Room State
  const [showCreateModal, setShowCreateModal] = useState(false);
  const [newRoomName, setNewRoomName] = useState("");
  const [newRoomPassword, setNewRoomPassword] = useState("");
  const [isCreating, setIsCreating] = useState(false);

  // Join Room State
  const [showPasswordModal, setShowPasswordModal] = useState(false);
  const [selectedRoomId, setSelectedRoomId] = useState<string | null>(null);
  const [roomPassword, setRoomPassword] = useState("");
  const [joinError, setJoinError] = useState("");
  const [isJoining, setIsJoining] = useState(false);

  const socketRef = useRef<Socket | null>(null);

  // Initialize Socket
  useEffect(() => {
    const token = localStorage.getItem("token");
    if (!token) {
      router.push("/login");
      return;
    }

    const API_URL = process.env.NEXT_PUBLIC_API_URL || "http://localhost:3001";
    
    // Create socket connection
    const newSocket = io(API_URL);
    socketRef.current = newSocket;

    // Real-time Room Updates
    newSocket.on("room-created", (newRoom: Room) => {
        setRooms(prev => {
            // Prevent duplicates
            if (prev.find(r => r.id === newRoom.id)) return prev;
            return [...prev, { ...newRoom, onlineCount: 0, users: [] }];
        });
    });

    newSocket.on("room-deleted", (roomId: string) => {
        setRooms(prev => prev.filter(r => r.id !== roomId));
    });

    // Handle reconnection - refresh room list
    newSocket.on("reconnect", () => {
        console.log("Rooms page: Socket reconnected, refreshing room list");
        fetchRooms();
    });

    fetchRooms();
    const interval = setInterval(fetchRooms, 5000);

    return () => {
      clearInterval(interval);
      newSocket.disconnect();
    };
  }, [router]);

  const fetchRooms = async () => {
    try {
      const API_URL = process.env.NEXT_PUBLIC_API_URL || "http://localhost:3001";
      const res = await fetch(`${API_URL}/api/rooms`);
      if (res.ok) {
        const data = await res.json();
        const sorted = data.sort((a: Room, b: Room) => b.onlineCount - a.onlineCount);
        setRooms(sorted);
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
        body: JSON.stringify({ 
          name: newRoomName, 
          userId: user.id,
          password: newRoomPassword.trim() || undefined
        }),
      });

      if (res.ok) {
        // Clear inputs and close modal
        setShowCreateModal(false);
        setNewRoomName("");
        setNewRoomPassword("");
        // Trigger immediate fetch
        await fetchRooms();
      }
    } catch (err) {
      console.error("Failed to create room", err);
    } finally {
      setIsCreating(false);
    }
  };

  const handleRoomClick = (room: Room) => {
    if (room.isPrivate) {
      setSelectedRoomId(room.id);
      setRoomPassword("");
      setJoinError("");
      setShowPasswordModal(true);
    } else {
      router.push(`/chat?roomId=${room.id}`);
    }
  };

  const handleJoinPrivateRoom = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!selectedRoomId || !roomPassword) return;

    setIsJoining(true);
    setJoinError("");

    try {
       const API_URL = process.env.NEXT_PUBLIC_API_URL || "http://localhost:3001";
       const res = await fetch(`${API_URL}/api/rooms/verify`, {
         method: "POST",
         headers: { "Content-Type": "application/json" },
         body: JSON.stringify({ roomId: selectedRoomId, password: roomPassword }),
       });

       const data = await res.json();

       if (res.ok && data.success) {
         setShowPasswordModal(false);
         router.push(`/chat?roomId=${selectedRoomId}`);
       } else {
         setJoinError(data.error || "Incorrect password");
       }

    } catch (err) {
       console.error("Join failed", err);
       setJoinError("Connection failed");
    } finally {
      setIsJoining(false);
    }
  };

  if (loading) {
    return (
      <div className="min-h-screen bg-black flex items-center justify-center text-white">
        Loading...
      </div>
    );
  }

  return (
    <div className="relative min-h-screen bg-black text-white font-sans overflow-hidden">
      {/* Background Particles */}
      <div className="absolute inset-0 pointer-events-none">
        <Particles
          particleColors={["#ffffff", "#6366f1"]}
          particleCount={150}
          particleSpread={15}
          speed={0.05}
          particleBaseSize={80}
          moveParticlesOnHover={false}
          alphaParticles={false}
          disableRotation={false}
        />
      </div>

      <div className="relative z-10 p-8">
        <div className="max-w-6xl mx-auto">
          <header className="mb-12 flex items-center justify-between backdrop-blur-md bg-black/30 p-6 rounded-lg border border-white/5">
            <div>
              <h1 className="text-3xl font-bold bg-white bg-clip-text text-transparent">
                Active Servers
              </h1>
              <p className="text-zinc-400 mt-1">Select a server to tune in.</p>
            </div>
            <button 
              onClick={() => {
                localStorage.clear();
                router.push("/login");
              }}
              className="text-sm text-zinc-500 hover:text-white transition-colors"
            >
              Disconnect
            </button>
          </header>

          <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-6">
            {/* Create Room Card */}
            <MagicCard 
              className="h-64 cursor-pointer"
              glowColor="255, 255, 255"
              onClick={() => setShowCreateModal(true)}
            >
              <div className="flex flex-col items-center justify-center h-full gap-4 relative z-10">
                <div className="w-16 h-16 rounded-full bg-zinc-900 flex items-center justify-center border border-zinc-800">
                  <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="text-zinc-400"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
                </div>
                <span className="font-medium text-zinc-400">Create Server</span>
              </div>
            </MagicCard>

            {/* Room Cards - Sorted by Online Count */}
            {rooms.map((room) => (
              <MagicCard 
                key={room.id}
                className="h-64 cursor-pointer"
                glowColor="99, 102, 241"
                onClick={() => handleRoomClick(room)}
              >
                <div className="flex flex-col h-full justify-between relative z-10">
                  <div>
                    <div className="flex justify-between items-start mb-4">
                      <div className="w-12 h-12 rounded-lg bg-gradient-to-br from-indigo-500/20 to-purple-500/20 border border-white/10 flex items-center justify-center text-xl font-bold text-white shadow-[0_0_15px_rgba(99,102,241,0.3)]">
                        {room.name[0].toUpperCase()}
                      </div>
                      <div className="flex flex-col items-end gap-1">
                        <div className={`px-3 py-1 rounded-md border text-[10px] font-bold uppercase tracking-wider ${room.onlineCount > 0 ? 'bg-green-500/10 text-green-400 border-green-500/20' : 'bg-zinc-800 text-zinc-500 border-zinc-700'}`}>
                          {room.onlineCount} Online
                        </div>
                        {room.isPrivate && (
                          <div className="text-zinc-500" title="Private Room">
                            <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="3" y="11" width="18" height="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>
                          </div>
                        )}
                      </div>
                    </div>
                    <h3 className="text-2xl font-bold text-white truncate tracking-tight">{room.name}</h3>
                    <p className="text-xs text-zinc-500 mt-1 font-mono">#{room.id.split('-')[0]}</p>
                  </div>
                  
                  <div className="space-y-3">
                     {/* User List Preview */}
                     <div className="h-10 flex -space-x-2 overflow-hidden">
                       {room.users.length > 0 ? (
                         room.users.slice(0, 5).map((u, i) => (
                           <div key={i} className="w-8 h-8 rounded-full bg-zinc-800 border-2 border-black flex items-center justify-center text-[10px] font-bold text-zinc-400" title={u}>
                             {u[0].toUpperCase()}
                           </div>
                         ))
                       ) : (
                         <span className="text-xs text-zinc-600 italic py-2">No active signals</span>
                       )}
                       {room.users.length > 5 && (
                          <div className="w-8 h-8 rounded-full bg-zinc-800 border-2 border-black flex items-center justify-center text-[10px] text-zinc-500">
                            +{room.users.length - 5}
                          </div>
                       )}
                     </div>

                    <div className="pt-4 border-t border-white/5 flex items-center justify-between group">
                      <span className="text-xs text-zinc-500 group-hover:text-indigo-400 transition-colors">
                        {room.isPrivate ? "Unlock Server" : "Join Server"}
                      </span>
                      {room.isPrivate ? (
                        <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="text-zinc-600 group-hover:translate-x-1 transition-transform group-hover:text-indigo-400"><rect x="3" y="11" width="18" height="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>
                      ) : (
                        <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="text-zinc-600 group-hover:translate-x-1 transition-transform group-hover:text-indigo-400"><path d="M5 12h14"/><path d="M12 5l7 7-7 7"/></svg>
                      )}
                    </div>
                  </div>
                </div>
              </MagicCard>
            ))}
          </div>
        </div>
      </div>

      {/* Create Room Modal */}
      {showCreateModal && (
        <div className="fixed inset-0 bg-black/80 backdrop-blur-md z-50 flex items-center justify-center p-4">
          <div className="bg-zinc-950 border border-zinc-800 rounded-xl w-full max-w-md p-6 shadow-2xl relative overflow-hidden">
             {/* Modal Particles Effect */}
             <div className="absolute inset-0 opacity-20 pointer-events-none">
                 <Particles particleCount={30} speed={0.05} />
             </div>

            <h2 className="text-xl font-bold mb-1 relative z-10">Initialize New Server</h2>
            <p className="text-xs text-zinc-500 mb-6 relative z-10">Create a new secure channel for communication.</p>
            
            <form onSubmit={createRoom} className="relative z-10 space-y-4">
              <div>
                <input 
                  type="text" 
                  placeholder="Server Name (e.g. Gaming)"
                  autoFocus
                  className="w-full bg-zinc-900 border border-zinc-700 rounded-lg p-4 text-white focus:outline-none focus:border-indigo-500 focus:ring-1 focus:ring-indigo-500/50 transition-all"
                  value={newRoomName}
                  onChange={(e) => setNewRoomName(e.target.value)}
                />
              </div>
              <div>
                <input 
                  type="password" 
                  placeholder="Password (Optional)"
                  className="w-full bg-zinc-900 border border-zinc-700 rounded-lg p-4 text-white focus:outline-none focus:border-indigo-500 focus:ring-1 focus:ring-indigo-500/50 transition-all placeholder-zinc-600"
                  value={newRoomPassword}
                  onChange={(e) => setNewRoomPassword(e.target.value)}
                />
                <p className="text-[10px] text-zinc-500 mt-2 px-1">Leave empty for a public server.</p>
              </div>

              <div className="flex gap-3 justify-end pt-2">
                <button 
                  type="button"
                  onClick={() => setShowCreateModal(false)}
                  className="px-4 py-2 rounded-lg text-zinc-400 hover:text-white hover:bg-zinc-900 transition-colors"
                >
                  Cancel
                </button>
                <button 
                  type="submit"
                  disabled={isCreating || !newRoomName.trim()}
                  className="px-6 py-2 bg-indigo-600 hover:bg-indigo-500 text-white rounded-lg disabled:opacity-50 font-medium shadow-lg shadow-indigo-500/20"
                >
                  {isCreating ? "Initializing..." : "Create"}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Join Private Room Modal */}
      {showPasswordModal && (
        <div className="fixed inset-0 bg-black/80 backdrop-blur-md z-50 flex items-center justify-center p-4">
          <div className="bg-zinc-950 border border-zinc-800 rounded-xl w-full max-w-sm p-6 shadow-2xl relative overflow-hidden">
            <h2 className="text-xl font-bold mb-1 relative z-10 text-center">Secure Server</h2>
            <p className="text-xs text-zinc-500 mb-6 relative z-10 text-center">Authentication required to proceed.</p>
            
            {joinError && (
              <div className="bg-red-500/10 text-red-400 p-2 rounded mb-4 text-xs text-center border border-red-500/20">
                {joinError}
              </div>
            )}

            <form onSubmit={handleJoinPrivateRoom} className="relative z-10">
              <input 
                type="password" 
                placeholder="Enter Access Code"
                autoFocus
                className="w-full bg-zinc-900 border border-zinc-700 rounded-lg p-4 text-white text-center tracking-widest focus:outline-none focus:border-indigo-500 focus:ring-1 focus:ring-indigo-500/50 mb-6 transition-all"
                value={roomPassword}
                onChange={(e) => setRoomPassword(e.target.value)}
              />
              <div className="flex gap-3 justify-center">
                <button 
                  type="button"
                  onClick={() => setShowPasswordModal(false)}
                  className="px-4 py-2 rounded-lg text-zinc-400 hover:text-white hover:bg-zinc-900 transition-colors"
                >
                  Cancel
                </button>
                <button 
                  type="submit"
                  disabled={isJoining || !roomPassword}
                  className="px-6 py-2 bg-indigo-600 hover:bg-indigo-500 text-white rounded-lg disabled:opacity-50 font-medium shadow-lg shadow-indigo-500/20"
                >
                  {isJoining ? "Verifying..." : "Access"}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
