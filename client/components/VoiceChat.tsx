"use client";

import { useEffect, useRef, useState } from "react";
import { Socket } from "socket.io-client";
import { createPortal } from "react-dom";

interface VoiceChatProps {
  socket: Socket | null;
  roomId: string;
  user: { id: number; username: string };
}

interface VoiceRoom {
  id: string;
  name: string;
}

// Sound effects
const playJoinSound = () => {
  if (typeof window === "undefined") return;
  const audio = new Audio("/sounds/join.mp3");
  audio.volume = 0.5;
  audio.play().catch(() => {});
};

const playLeaveSound = () => {
  if (typeof window === "undefined") return;
  const audio = new Audio("/sounds/leave.mp3");
  audio.volume = 0.5;
  audio.play().catch(() => {});
};

export default function VoiceChat({ socket, roomId: defaultRoomId, user }: VoiceChatProps) {
  const [inVoice, setInVoice] = useState(false);
  const [currentRoom, setCurrentRoom] = useState<string | null>(null);
  const [PeerClass, setPeerClass] = useState<any>(null);
  const [isSharingScreen, setIsSharingScreen] = useState(false);
  const [peers, setPeers] = useState<{ peerID: string; peer: any; volume: number; username: string }[]>([]);
  const [incomingStreams, setIncomingStreams] = useState<{ id: string; stream: MediaStream }[]>([]);
  const [isMuted, setIsMuted] = useState(false);
  const [isDeafened, setIsDeafened] = useState(false);
  const [mounted, setMounted] = useState(false);
  const [showAddRoom, setShowAddRoom] = useState(false);
  const [showKeybindSettings, setShowKeybindSettings] = useState(false);
  const [keybinds, setKeybinds] = useState({
    mute: { key: "m", alt: true, ctrl: false, shift: false },
    deafen: { key: "d", alt: true, ctrl: false, shift: false },
  });
  const [editingKeybind, setEditingKeybind] = useState<"mute" | "deafen" | null>(null);
  const [newRoomName, setNewRoomName] = useState("");
  const [voiceRooms, setVoiceRooms] = useState<VoiceRoom[]>([
    { id: "general", name: "General" },
    { id: "gaming", name: "Gaming" },
  ]);

  const peersRef = useRef<{ peerID: string; peer: any }[]>([]);
  const localStream = useRef<MediaStream | null>(null);
  const screenStream = useRef<MediaStream | null>(null);

  // Load Peer dynamically on mount
  useEffect(() => {
    setMounted(true);
    
    // Load keybinds from localStorage
    const savedKeybinds = localStorage.getItem("voiceKeybinds");
    if (savedKeybinds) {
      try {
        setKeybinds(JSON.parse(savedKeybinds));
      } catch (e) {
        console.error("Failed to parse saved keybinds");
      }
    }
    
    import("simple-peer")
      .then((mod) => {
        setPeerClass(() => mod.default);
      })
      .catch((err) => {
        console.error("Failed to load simple-peer:", err);
      });
  }, []);

  // Keyboard Shortcuts
  useEffect(() => {
    if (!mounted) return;
    
    const checkKeybind = (e: KeyboardEvent, bind: typeof keybinds.mute) => {
      const keyMatch = e.key.toLowerCase() === bind.key.toLowerCase();
      const altMatch = e.altKey === bind.alt;
      const ctrlMatch = e.ctrlKey === bind.ctrl;
      const shiftMatch = e.shiftKey === bind.shift;
      return keyMatch && altMatch && ctrlMatch && shiftMatch;
    };
    
    const handleKeyDown = (e: KeyboardEvent) => {
      // Don't trigger if editing keybind
      if (editingKeybind) return;
      
      if (checkKeybind(e, keybinds.mute)) {
        e.preventDefault();
        toggleMute();
      }
      if (checkKeybind(e, keybinds.deafen)) {
        e.preventDefault();
        toggleDeafen();
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [inVoice, isMuted, isDeafened, mounted, PeerClass, voiceRooms, keybinds, editingKeybind]);

  // Clean up on unmount
  useEffect(() => {
    return () => {
      if (localStream.current) {
        localStream.current.getTracks().forEach((t) => t.stop());
      }
    };
  }, []);

  const toggleMute = () => {
    if (localStream.current) {
      const audioTrack = localStream.current.getAudioTracks()[0];
      if (audioTrack) {
        audioTrack.enabled = !audioTrack.enabled;
        setIsMuted(!audioTrack.enabled);
      }
    }
  };

  const toggleDeafen = () => {
    setIsDeafened((prev) => !prev);
  };

  // Apply deafen to all audio players
  useEffect(() => {
    // This will trigger re-render of AudioPlayer components with updated volume
  }, [isDeafened]);

  const joinVoice = (roomId: string) => {
    if (!socket || !PeerClass) return;
    if (inVoice) leaveVoice(); // Leave current room first

    playJoinSound();

    navigator.mediaDevices
      .getUserMedia({ video: false, audio: true })
      .then((stream) => {
        setInVoice(true);
        setCurrentRoom(roomId);
        setIsMuted(false);
        localStream.current = stream;

        socket.emit("join-voice", { roomId, user });

        socket.on("all-voice-users", (users: { id: string; username: string }[]) => {
          const peersArr: { peerID: string; peer: any; volume: number; username: string }[] = [];
          users.forEach((u) => {
            if (socket.id) {
              const peer = createPeer(u.id, socket.id, stream, user.username);
              peersRef.current.push({ peerID: u.id, peer });
              peersArr.push({ peerID: u.id, peer, volume: 100, username: u.username });
            }
          });
          setPeers(peersArr);
        });

        socket.on("user-joined-voice", (payload: { signal: any; callerID: string; username: string }) => {
          const existing = peersRef.current.find((p) => p.peerID === payload.callerID);
          if (existing) {
            existing.peer.signal(payload.signal);
            return;
          }
          playJoinSound();
          const peer = addPeer(payload.signal, payload.callerID, stream);
          peersRef.current.push({ peerID: payload.callerID, peer });
          setPeers((prev) => [...prev, { peerID: payload.callerID, peer, volume: 100, username: payload.username }]);
        });

        socket.on("receiving-returned-signal", (payload: { signal: any; id: string }) => {
          const item = peersRef.current.find((p) => p.peerID === payload.id);
          if (item) {
            item.peer.signal(payload.signal);
          }
        });

        socket.on("user-left-voice", (id: string) => {
          playLeaveSound();
          const peerObj = peersRef.current.find((p) => p.peerID === id);
          if (peerObj) peerObj.peer.destroy();
          peersRef.current = peersRef.current.filter((p) => p.peerID !== id);
          setPeers((prev) => prev.filter((p) => p.peerID !== id));
          setIncomingStreams((prev) => prev.filter((s) => s.id !== id));
        });
      })
      .catch((err) => {
        console.error("Failed to get local stream", err);
        alert("Could not access microphone. Please allow permissions.");
      });
  };

  const leaveVoice = () => {
    if (!inVoice) return;

    playLeaveSound();
    stopScreenShare();
    setInVoice(false);
    setCurrentRoom(null);
    socket?.emit("leave-voice");

    localStream.current?.getTracks().forEach((track) => track.stop());
    localStream.current = null;

    peersRef.current.forEach((p) => p.peer.destroy());
    peersRef.current = [];
    setPeers([]);
    setIncomingStreams([]);

    socket?.off("all-voice-users");
    socket?.off("user-joined-voice");
    socket?.off("receiving-returned-signal");
    socket?.off("user-left-voice");
  };

  const createPeer = (userToSignal: string, callerID: string, stream: MediaStream, myUsername: string) => {
    const peer = new PeerClass({
      initiator: true,
      trickle: false,
      stream,
    });

    peer.on("signal", (signal: any) => {
      socket?.emit("sending-signal", { userToSignal, callerID, signal, username: myUsername });
    });

    peer.on("stream", (remoteStream: MediaStream) => {
      handleIncomingStream(userToSignal, remoteStream);
    });

    peer.on("error", (err: any) => {
      console.error("Peer error:", err);
    });

    return peer;
  };

  const addPeer = (incomingSignal: any, callerID: string, stream: MediaStream) => {
    const peer = new PeerClass({
      initiator: false,
      trickle: false,
      stream,
    });

    peer.on("signal", (signal: any) => {
      socket?.emit("returning-signal", { signal, callerID });
    });

    peer.on("stream", (remoteStream: MediaStream) => {
      handleIncomingStream(callerID, remoteStream);
    });

    peer.on("error", (err: any) => {
      console.error("Peer error:", err);
    });

    peer.signal(incomingSignal);

    return peer;
  };

  const handleIncomingStream = (id: string, stream: MediaStream) => {
    // Handle audio streams
    const audioTracks = stream.getAudioTracks();
    if (audioTracks.length > 0) {
      // Audio is handled by AudioPlayer component, just update peers
      setPeers((prev) => {
        const updated = [...prev];
        const peerIndex = updated.findIndex((p) => p.peerID === id);
        if (peerIndex !== -1) {
          // Trigger re-render for AudioPlayer
          updated[peerIndex] = { ...updated[peerIndex] };
        }
        return updated;
      });
    }

    // Handle video streams (screen share)
    const videoTracks = stream.getVideoTracks();
    if (videoTracks.length > 0) {
      setIncomingStreams((prev) => {
        if (prev.find((s) => s.id === id && s.stream.id === stream.id)) return prev;
        return [...prev, { id, stream }];
      });
    }
  };

  const startScreenShare = () => {
    if (!PeerClass) return;
    navigator.mediaDevices
      .getDisplayMedia({ video: true, audio: false })
      .then((stream: MediaStream) => {
        setIsSharingScreen(true);
        screenStream.current = stream;

        peersRef.current.forEach((p) => {
          stream.getTracks().forEach((track) => {
            p.peer.addTrack(track, stream);
          });
        });

        stream.getVideoTracks()[0].onended = () => {
          stopScreenShare();
        };
      })
      .catch((err: any) => {
        console.error("Failed to share screen", err);
      });
  };

  const stopScreenShare = () => {
    if (!screenStream.current) return;
    
    // Stop all tracks immediately
    screenStream.current.getTracks().forEach((track) => {
      track.stop();
      track.enabled = false;
    });

    // Remove tracks from peers
    peersRef.current.forEach((p) => {
      try {
        const senders = p.peer._pc?.getSenders?.() || [];
        senders.forEach((sender: RTCRtpSender) => {
          if (sender.track?.kind === 'video') {
            p.peer._pc?.removeTrack?.(sender);
          }
        });
      } catch (e) {
        // Ignore errors when removing tracks
      }
    });

    // Clear all incoming streams and stop their tracks
    setIncomingStreams((prev) => {
      prev.forEach((s) => {
        s.stream.getTracks().forEach((track) => {
          track.stop();
          track.enabled = false;
        });
      });
      return [];
    });

    // Clear state
    screenStream.current = null;
    setIsSharingScreen(false);
  };

  const handleVolumeChange = (peerId: string, newVolume: number) => {
    setPeers((prev) => prev.map((p) => (p.peerID === peerId ? { ...p, volume: newVolume } : p)));
  };

  const addVoiceRoom = () => {
    if (!newRoomName.trim()) return;
    const newRoom: VoiceRoom = {
      id: newRoomName.toLowerCase().replace(/\s+/g, "-"),
      name: newRoomName,
    };
    setVoiceRooms((prev) => [...prev, newRoom]);
    setNewRoomName("");
    setShowAddRoom(false);
  };

  const formatKeybind = (bind: typeof keybinds.mute) => {
    const parts = [];
    if (bind.ctrl) parts.push("Ctrl");
    if (bind.alt) parts.push("Alt");
    if (bind.shift) parts.push("Shift");
    parts.push(bind.key.toUpperCase());
    return parts.join("+");
  };

  const handleKeybindCapture = (e: React.KeyboardEvent, type: "mute" | "deafen") => {
    e.preventDefault();
    e.stopPropagation();
    
    // Ignore modifier-only presses
    if (["Control", "Alt", "Shift", "Meta"].includes(e.key)) return;
    
    const newBind = {
      key: e.key,
      alt: e.altKey,
      ctrl: e.ctrlKey,
      shift: e.shiftKey,
    };
    
    const newKeybinds = { ...keybinds, [type]: newBind };
    setKeybinds(newKeybinds);
    localStorage.setItem("voiceKeybinds", JSON.stringify(newKeybinds));
    setEditingKeybind(null);
  };

  if (!mounted) return null;

  return (
    <>
      {/* Voice Channels Section */}
      <div className="flex-1 flex flex-col">
        <div className="px-3 py-2 flex items-center justify-between">
          <span className="text-zinc-500 text-xs font-semibold uppercase tracking-wider">Voice Channels</span>
          <button
            onClick={() => setShowAddRoom(!showAddRoom)}
            className="text-zinc-500 hover:text-white transition-colors p-1 rounded hover:bg-zinc-700"
            title="Add Voice Channel"
          >
            <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
          </button>
        </div>

        {showAddRoom && (
          <div className="px-3 pb-2">
            <div className="flex gap-1">
              <input
                type="text"
                value={newRoomName}
                onChange={(e) => setNewRoomName(e.target.value)}
                placeholder="Room name..."
                className="flex-1 bg-zinc-900 text-white text-xs rounded px-2 py-1.5 border border-zinc-600 focus:outline-none focus:border-indigo-500"
                onKeyDown={(e) => e.key === "Enter" && addVoiceRoom()}
              />
              <button
                onClick={addVoiceRoom}
                className="px-2 py-1 bg-indigo-600 hover:bg-indigo-500 rounded text-xs font-medium"
              >
                Add
              </button>
            </div>
          </div>
        )}

        <div className="px-2 space-y-0.5">
          {voiceRooms.map((room) => (
            <div key={room.id} className="group">
              <button
                onClick={() => (currentRoom === room.id ? leaveVoice() : joinVoice(room.id))}
                className={`w-full flex items-center gap-2 px-2 py-1.5 rounded text-sm transition-all ${
                  currentRoom === room.id
                    ? "bg-zinc-700 text-white"
                    : "text-zinc-400 hover:text-zinc-200 hover:bg-zinc-800"
                }`}
              >
                <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={currentRoom === room.id ? "text-green-400" : ""}>
                  <path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z"/>
                  <path d="M19 10v2a7 7 0 0 1-14 0v-2"/>
                </svg>
                <span>{room.name}</span>
                {currentRoom === room.id && (
                  <span className="ml-auto">
                    <span className="relative flex h-2 w-2">
                      <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-green-400 opacity-75"></span>
                      <span className="relative inline-flex rounded-full h-2 w-2 bg-green-500"></span>
                    </span>
                  </span>
                )}
              </button>
              
              {/* Show connected users under the room */}
              {currentRoom === room.id && (
                <div className="ml-6 mt-1 space-y-1">
                  {/* Show myself first */}
                  <div className="flex items-center gap-2 text-xs text-zinc-300 py-0.5">
                    <div className="w-5 h-5 rounded-full bg-gradient-to-br from-indigo-500 to-purple-600 flex items-center justify-center text-[10px] font-bold text-white">
                      {user.username[0].toUpperCase()}
                    </div>
                    <span className="flex-1 truncate">{user.username}</span>
                    <div className="flex items-center gap-1">
                      {/* Microphone status */}
                      {isMuted ? (
                        <svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="text-red-400">
                          <line x1="1" y1="1" x2="23" y2="23"/><path d="M9 9v3a3 3 0 0 0 5.12 2.12M15 9.34V4a3 3 0 0 0-5.94-.6"/>
                        </svg>
                      ) : (
                        <svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="text-green-400">
                          <path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z"/>
                        </svg>
                      )}
                      {/* Screen share status */}
                      {isSharingScreen && (
                        <svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="text-indigo-400">
                          <rect x="2" y="3" width="20" height="14" rx="2" ry="2"/><line x1="8" y1="21" x2="16" y2="21"/><line x1="12" y1="17" x2="12" y2="21"/>
                        </svg>
                      )}
                    </div>
                  </div>
                  {/* Show other users */}
                  {peers.map((p) => {
                    const isScreenSharing = incomingStreams.some((s) => s.id === p.peerID);
                    return (
                      <div key={p.peerID} className="flex items-center gap-2 text-xs text-zinc-400 py-0.5">
                        <div className="w-5 h-5 rounded-full bg-gradient-to-br from-emerald-500 to-teal-600 flex items-center justify-center text-[10px] font-bold text-white">
                          {(p.username || "?")[0].toUpperCase()}
                        </div>
                        <span className="flex-1 truncate">{p.username || `User ${p.peerID.substring(0, 4)}`}</span>
                        <div className="flex items-center gap-1">
                          {/* Headphone icon (connected) */}
                          <svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="text-green-400">
                            <path d="M3 18v-6a9 9 0 0 1 18 0v6"/><path d="M21 19a2 2 0 0 1-2 2h-1a2 2 0 0 1-2-2v-3a2 2 0 0 1 2-2h3zM3 19a2 2 0 0 0 2 2h1a2 2 0 0 0 2-2v-3a2 2 0 0 0-2-2H3z"/>
                          </svg>
                          {/* Screen share status */}
                          {isScreenSharing && (
                            <svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="text-indigo-400">
                              <rect x="2" y="3" width="20" height="14" rx="2" ry="2"/><line x1="8" y1="21" x2="16" y2="21"/><line x1="12" y1="17" x2="12" y2="21"/>
                            </svg>
                          )}
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          ))}
        </div>
      </div>

      {/* Voice Controls Panel (only when in voice) */}
      {inVoice && (
        <div className="p-3 bg-zinc-900/80 border-t border-zinc-700">
          <div className="flex items-center justify-between mb-2">
            <div className="flex items-center gap-2">
              <div className={`w-2 h-2 rounded-full ${isDeafened ? "bg-red-500" : "bg-green-500"} animate-pulse`}></div>
              <span className="text-xs text-zinc-300 font-medium">
                {isDeafened ? "Deafened" : isMuted ? "Muted" : "Connected"}
              </span>
            </div>
            <button
              onClick={() => setShowKeybindSettings(true)}
              className="text-[10px] text-zinc-500 hover:text-zinc-300 border border-zinc-700 hover:border-zinc-600 px-1.5 py-0.5 rounded transition-colors"
              title="Tus Ayarlari"
            >
              <svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="3"/><path d="M12 1v6m0 6v6m8.66-9h-6m-6 0H2.34m15.32-6.36l-4.24 4.24m-4.24 0L5.34 5.34m13.32 13.32l-4.24-4.24m-4.24 0l-4.24 4.24"/></svg>
            </button>
          </div>

          <div className="flex items-center justify-center gap-2">
            <button
              onClick={toggleMute}
              className={`p-2.5 rounded-full transition-all ${isMuted ? "bg-red-600 text-white" : "bg-zinc-700 text-zinc-300 hover:text-white hover:bg-zinc-600"}`}
              title={`Mute (${formatKeybind(keybinds.mute)})`}
            >
              {isMuted ? (
                <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><line x1="1" y1="1" x2="23" y2="23"/><path d="M9 9v3a3 3 0 0 0 5.12 2.12M15 9.34V4a3 3 0 0 0-5.94-.6"/></svg>
              ) : (
                <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z"/><path d="M19 10v2a7 7 0 0 1-14 0v-2"/><line x1="12" y1="19" x2="12" y2="23"/><line x1="8" y1="23" x2="16" y2="23"/></svg>
              )}
            </button>

            <button
              onClick={toggleDeafen}
              className={`p-2.5 rounded-full transition-all ${isDeafened ? "bg-red-600 text-white" : "bg-zinc-700 text-zinc-300 hover:text-white hover:bg-zinc-600"}`}
              title={`Deafen (${formatKeybind(keybinds.deafen)})`}
            >
              {isDeafened ? (
                <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><line x1="1" y1="1" x2="23" y2="23"/><path d="M3 14v-4a9 9 0 0 1 9-9v0"/><path d="M21 14v-4a9 9 0 0 0-9-9"/></svg>
              ) : (
                <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M3 18v-6a9 9 0 0 1 18 0v6"/><path d="M21 19a2 2 0 0 1-2 2h-1a2 2 0 0 1-2-2v-3a2 2 0 0 1 2-2h3zM3 19a2 2 0 0 0 2 2h1a2 2 0 0 0 2-2v-3a2 2 0 0 0-2-2H3z"/></svg>
              )}
            </button>

            <button
              onClick={isSharingScreen ? stopScreenShare : startScreenShare}
              className={`p-2.5 rounded-full transition-all ${isSharingScreen ? "bg-indigo-600 text-white" : "bg-zinc-700 text-zinc-300 hover:text-white hover:bg-zinc-600"}`}
              title="Share Screen"
            >
              <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="2" y="3" width="20" height="14" rx="2" ry="2"/><line x1="8" y1="21" x2="16" y2="21"/><line x1="12" y1="17" x2="12" y2="21"/></svg>
            </button>

            <button
              onClick={leaveVoice}
              className="p-2.5 rounded-full bg-red-600/20 text-red-400 hover:bg-red-600/40 transition-all"
              title="Disconnect"
            >
              <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M10.68 13.31a16 16 0 0 0 3.41 2.6l1.27-1.27a2 2 0 0 1 2.11-.45 12.84 12.84 0 0 0 2.81.7 2 2 0 0 1 1.72 2v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.42 19.42 0 0 1-3.33-2.67m-2.67-3.34a19.79 19.79 0 0 1-3.07-8.63A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72 12.84 12.84 0 0 0 .7 2.81 2 2 0 0 1-.45 2.11L8.09 9.91"/><line x1="23" y1="1" x2="1" y2="23"/></svg>
            </button>
          </div>

          {/* Volume Controls with Percentage */}
          {peers.length > 0 && (
            <div className="mt-3 pt-3 border-t border-zinc-700 space-y-2">
              <span className="text-[10px] uppercase text-zinc-500 font-bold">User Volume</span>
              {peers.map((p) => (
                <div key={p.peerID} className="flex items-center gap-2">
                  <div className="w-5 h-5 rounded-full bg-indigo-600 flex items-center justify-center text-[10px] font-bold text-white flex-shrink-0">
                    {(p.username || "?")[0].toUpperCase()}
                  </div>
                  <span className="text-xs text-zinc-300 w-16 truncate">{p.username || "User"}</span>
                  <input
                    type="range"
                    min="0"
                    max="100"
                    step="1"
                    value={p.volume}
                    onChange={(e) => handleVolumeChange(p.peerID, parseInt(e.target.value))}
                    className="flex-1 h-1 bg-zinc-600 rounded-lg appearance-none cursor-pointer accent-indigo-500"
                  />
                  <span className="text-[10px] text-zinc-400 w-8 text-right font-mono">{p.volume}%</span>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* Audio Players */}
      {peers.map((p) => (
        <AudioPlayer key={p.peerID} peer={p.peer} volume={isDeafened ? 0 : p.volume / 100} />
      ))}

      {/* Keybind Settings Modal */}
      {showKeybindSettings && mounted && createPortal(
        <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50" onClick={() => setShowKeybindSettings(false)}>
          <div className="bg-zinc-800 rounded-xl p-6 w-80 shadow-2xl border border-zinc-700" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between mb-4">
              <h3 className="text-lg font-bold text-white">Tus Ayarlari</h3>
              <button
                onClick={() => setShowKeybindSettings(false)}
                className="text-zinc-500 hover:text-white transition-colors"
              >
                <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
              </button>
            </div>
            
            <div className="space-y-4">
              {/* Mute Keybind */}
              <div>
                <label className="text-xs text-zinc-400 uppercase font-semibold mb-2 block">Mikrofonu Kapat/Ac</label>
                {editingKeybind === "mute" ? (
                  <input
                    type="text"
                    autoFocus
                    placeholder="Bir tusa bas..."
                    className="w-full bg-zinc-900 text-white text-sm rounded-lg px-3 py-2 border-2 border-indigo-500 focus:outline-none"
                    onKeyDown={(e) => handleKeybindCapture(e, "mute")}
                    onBlur={() => setEditingKeybind(null)}
                    readOnly
                  />
                ) : (
                  <button
                    onClick={() => setEditingKeybind("mute")}
                    className="w-full bg-zinc-900 text-white text-sm rounded-lg px-3 py-2 border border-zinc-600 hover:border-zinc-500 text-left transition-colors"
                  >
                    {formatKeybind(keybinds.mute)}
                  </button>
                )}
              </div>
              
              {/* Deafen Keybind */}
              <div>
                <label className="text-xs text-zinc-400 uppercase font-semibold mb-2 block">Kulakligi Kapat/Ac</label>
                {editingKeybind === "deafen" ? (
                  <input
                    type="text"
                    autoFocus
                    placeholder="Bir tusa bas..."
                    className="w-full bg-zinc-900 text-white text-sm rounded-lg px-3 py-2 border-2 border-indigo-500 focus:outline-none"
                    onKeyDown={(e) => handleKeybindCapture(e, "deafen")}
                    onBlur={() => setEditingKeybind(null)}
                    readOnly
                  />
                ) : (
                  <button
                    onClick={() => setEditingKeybind("deafen")}
                    className="w-full bg-zinc-900 text-white text-sm rounded-lg px-3 py-2 border border-zinc-600 hover:border-zinc-500 text-left transition-colors"
                  >
                    {formatKeybind(keybinds.deafen)}
                  </button>
                )}
              </div>
            </div>
            
            <p className="text-[10px] text-zinc-500 mt-4">Tusa tiklayip yeni tusunu girin. Ctrl, Alt, Shift kombinasyonlari desteklenir.</p>
          </div>
        </div>,
        document.body
      )}

      {/* Screen Share Overlay */}
      {mounted &&
        incomingStreams.length > 0 &&
        createPortal(
          <>
            {incomingStreams.map((item) => {
              const peerData = peers.find((p) => p.peerID === item.id);
              const name = peerData ? peerData.username : item.id.substring(0, 4);
              return (
                <VideoPlayer
                  key={item.id + item.stream.id}
                  stream={item.stream}
                  name={name}
                  onClose={() => {
                    // Stop stream tracks to free memory
                    item.stream.getTracks().forEach((track) => track.stop());
                    setIncomingStreams((prev) => prev.filter((s) => s.id !== item.id || s.stream.id !== item.stream.id));
                  }}
                />
              );
            })}
          </>,
          document.body
        )}
    </>
  );
}

const AudioPlayer = ({ peer, volume = 1 }: { peer: any; volume?: number }) => {
  const ref = useRef<HTMLAudioElement>(null);
  const [hasStream, setHasStream] = useState(false);

  useEffect(() => {
    const handler = (stream: MediaStream) => {
      const audioTracks = stream.getAudioTracks();
      if (audioTracks.length > 0) {
        const audioStream = new MediaStream(audioTracks);
        if (ref.current) {
          ref.current.srcObject = audioStream;
          ref.current.play().catch(() => {});
          setHasStream(true);
        }
      }
    };
    peer.on("stream", handler);
    
    // If peer already has remote streams (reconnection case)
    if (peer._remoteStreams && peer._remoteStreams.length > 0) {
      handler(peer._remoteStreams[0]);
    }
    
    return () => {
      peer.off("stream", handler);
    };
  }, [peer]);

  useEffect(() => {
    if (ref.current) {
      ref.current.volume = Math.max(0, Math.min(1, volume));
    }
  }, [volume]);

  return <audio ref={ref} autoPlay playsInline style={{ display: "none" }} />;
};

const VideoPlayer = ({ stream, name, onClose }: { stream: MediaStream; name: string; onClose: () => void }) => {
  const ref = useRef<HTMLVideoElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const [isExpanded, setIsExpanded] = useState(false);
  const [position, setPosition] = useState({ x: 20, y: 20 });
  const [size, setSize] = useState({ width: 400, height: 225 });
  const [isDragging, setIsDragging] = useState(false);
  const [isResizing, setIsResizing] = useState(false);
  const dragRef = useRef({ startX: 0, startY: 0, initialX: 0, initialY: 0 });
  const resizeRef = useRef({ startX: 0, startY: 0, initialW: 0, initialH: 0 });

  useEffect(() => {
    if (ref.current) ref.current.srcObject = stream;
    
    // Cleanup when component unmounts or stream changes
    return () => {
      if (ref.current) {
        ref.current.srcObject = null;
      }
    };
  }, [stream]);

  const handleMouseDown = (e: React.MouseEvent) => {
    if ((e.target as HTMLElement).closest("button")) return;
    if ((e.target as HTMLElement).classList.contains("resize-handle")) return;
    
    setIsDragging(true);
    dragRef.current = {
      startX: e.clientX,
      startY: e.clientY,
      initialX: position.x,
      initialY: position.y,
    };
  };

  const handleResizeStart = (e: React.MouseEvent) => {
    e.stopPropagation();
    setIsResizing(true);
    resizeRef.current = {
      startX: e.clientX,
      startY: e.clientY,
      initialW: size.width,
      initialH: size.height,
    };
  };

  useEffect(() => {
    const handleMouseMove = (e: MouseEvent) => {
      if (isDragging) {
        const dx = e.clientX - dragRef.current.startX;
        const dy = e.clientY - dragRef.current.startY;
        setPosition({
          x: dragRef.current.initialX - dx,
          y: dragRef.current.initialY + dy,
        });
      }
      if (isResizing) {
        const dx = e.clientX - resizeRef.current.startX;
        const dy = e.clientY - resizeRef.current.startY;
        setSize({
          width: Math.max(200, resizeRef.current.initialW - dx),
          height: Math.max(120, resizeRef.current.initialH + dy),
        });
      }
    };
    const handleMouseUp = () => {
      setIsDragging(false);
      setIsResizing(false);
    };

    if (isDragging || isResizing) {
      window.addEventListener("mousemove", handleMouseMove);
      window.addEventListener("mouseup", handleMouseUp);
    }
    return () => {
      window.removeEventListener("mousemove", handleMouseMove);
      window.removeEventListener("mouseup", handleMouseUp);
    };
  }, [isDragging, isResizing]);

  return (
    <div
      ref={containerRef}
      className={`fixed z-50 bg-black rounded-lg overflow-hidden shadow-2xl border border-zinc-600 transition-all ${
        isExpanded ? "inset-4" : "cursor-move"
      }`}
      style={
        !isExpanded
          ? { right: `${position.x}px`, top: `${position.y}px`, width: `${size.width}px`, height: `${size.height}px` }
          : {}
      }
      onMouseDown={!isExpanded ? handleMouseDown : undefined}
    >
      {/* Header */}
      <div className="absolute top-0 left-0 right-0 bg-gradient-to-b from-black/80 to-transparent p-2 flex items-center justify-between z-20">
        <div className="flex items-center gap-2">
          <div className="w-6 h-6 rounded-full bg-indigo-600 flex items-center justify-center text-xs font-bold text-white">
            {name[0].toUpperCase()}
          </div>
          <span className="text-xs text-white font-medium">{name}&apos;s Screen</span>
        </div>
        <div className="flex items-center gap-1">
          <button
            onClick={() => setIsExpanded(!isExpanded)}
            className="p-1.5 bg-black/40 hover:bg-black/60 rounded text-white transition-colors"
            title={isExpanded ? "Kucult" : "Buyut"}
          >
            {isExpanded ? (
              <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M8 3v3a2 2 0 0 1-2 2H3m18 0h-3a2 2 0 0 1-2-2V3m0 18v-3a2 2 0 0 1 2-2h3M3 16h3a2 2 0 0 1 2 2v3"/></svg>
            ) : (
              <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M15 3h6v6M9 21H3v-6M21 3l-7 7M3 21l7-7"/></svg>
            )}
          </button>
          <button
            onClick={onClose}
            className="p-1.5 bg-red-600/60 hover:bg-red-600 rounded text-white transition-colors"
            title="Kapat"
          >
            <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
          </button>
        </div>
      </div>
      
      <video ref={ref} autoPlay playsInline className="w-full h-full object-contain bg-black" />
      
      {/* Resize Handle */}
      {!isExpanded && (
        <div
          className="resize-handle absolute bottom-0 left-0 w-4 h-4 cursor-sw-resize"
          onMouseDown={handleResizeStart}
        >
          <svg className="w-4 h-4 text-zinc-500" viewBox="0 0 24 24" fill="currentColor">
            <path d="M22 22H20V20H22V22ZM22 18H18V22H22V18ZM18 22H14V20H18V22Z"/>
          </svg>
        </div>
      )}
    </div>
  );
};
