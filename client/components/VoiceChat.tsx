"use client";

import { useEffect, useRef, useState } from "react";
import { Socket } from "socket.io-client";
import { createPortal } from "react-dom";

interface VoiceChatProps {
  socket: Socket | null;
  roomId: string;
  user: { id: number; username: string };
}

export default function VoiceChat({ socket, roomId, user }: VoiceChatProps) {
  const [inVoice, setInVoice] = useState(false);
  const [Peer, setPeer] = useState<any>(null); // Store Peer class dynamically
  const [isSharingScreen, setIsSharingScreen] = useState(false);
  
  // Load Peer and Polyfills on mount
  useEffect(() => {
    // Apply polyfills immediately
    if (typeof window !== "undefined") {
      if ((window as any).global === undefined) (window as any).global = window;
      if ((window as any).process === undefined) (window as any).process = { env: {} };
      
      // Load simple-peer
      import("simple-peer").then((module) => {
        setPeer(() => module.default);
      });
    }
  }, []);

  const [peers, setPeers] = useState<{ peerID: string, peer: any, volume: number, username: string }[]>([]);
  const [incomingStreams, setIncomingStreams] = useState<{ id: string, stream: MediaStream }[]>([]);
  const [isMuted, setIsMuted] = useState(false);
  
  const userAudio = useRef<HTMLAudioElement>(null);
  const peersRef = useRef<{ peerID: string; peer: any }[]>([]);
  const localStream = useRef<MediaStream | null>(null);
  const screenStream = useRef<MediaStream | null>(null);


  // ... Keyboard Shortcuts & Clean up ...

  const toggleMute = () => {
     // ...
  };

  const joinVoice = () => {
    if (!socket || !Peer) return;
    
    playJoinSound();

    navigator.mediaDevices.getUserMedia({ video: false, audio: true })
      .then(stream => {
        setInVoice(true);
        setIsMuted(false);
        localStream.current = stream;
        
        // Send user object with join request
        socket.emit("join-voice", { roomId, user });

        socket.on("all-voice-users", (users: { id: string, username: string }[]) => {
          const peersArr: { peerID: string, peer: any, volume: number, username: string }[] = [];
          users.forEach(u => {
            if (socket.id) {
                const peer = createPeer(u.id, socket.id, stream, user.username);
                peersRef.current.push({ peerID: u.id, peer });
                peersArr.push({ peerID: u.id, peer, volume: 1.0, username: u.username });
            }
          });
          setPeers(peersArr);
        });

        socket.on("user-joined-voice", (payload: { signal: any, callerID: string, username: string }) => {
          const item = peersRef.current.find(p => p.peerID === payload.callerID);
          
          // If peer already exists, this is a renegotiation signal (e.g. screen share)
          if (item) {
             console.log("Renegotiating with existing peer:", payload.callerID);
             item.peer.signal(payload.signal);
             return;
          }

          // New peer joining
          playJoinSound();
          const peer = addPeer(payload.signal, payload.callerID, stream);
          peersRef.current.push({ peerID: payload.callerID, peer });
          setPeers(users => [...users, { peerID: payload.callerID, peer, volume: 1.0, username: payload.username }]);
        });

        socket.on("receiving-returned-signal", (payload: { signal: any, id: string }) => {
          const item = peersRef.current.find(p => p.peerID === payload.id);
          if (item) {
            item.peer.signal(payload.signal);
          }
        });
        
        // ... user-left-voice ...
      })
      .catch(err => {
        // ...
      });
  };

  // ... leaveVoice ...

  const createPeer = (userToSignal: string, callerID: string, stream: MediaStream, myUsername: string) => {
    const peer = new Peer({
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
    
    // Add error handling
    peer.on("error", (err: any) => {
        console.error("Peer error:", err);
    });

    return peer;
  };

  const addPeer = (incomingSignal: any, callerID: string, stream: MediaStream) => {
    const peer = new Peer({
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

  // ... handleIncomingStream ...

  // ... startScreenShare / stopScreenShare ...

  // ... handleVolumeChange ...

  return (
    <>
      {/* Voice Controls & User List */}
      <div className="p-3 bg-zinc-900 border-t border-zinc-700 flex flex-col gap-2">
         {/* ... Controls ... */}

        {/* Volume Controls for Peers */}
        {inVoice && peers.length > 0 && (
          <div className="flex flex-col gap-1 mt-2 p-2 bg-zinc-800 rounded border border-zinc-700">
            <span className="text-[10px] uppercase text-zinc-500 font-bold mb-1">Voice Volume</span>
            {peers.map((p) => (
              <div key={p.peerID} className="flex items-center justify-between text-xs">
                 <span className="text-zinc-300 w-16 truncate" title={p.username || p.peerID}>
                    {p.username || `User ${p.peerID.substring(0,4)}`}
                 </span>
                 <input 
                   type="range" 
                   min="0" 
                   max="1" 
                   step="0.1" 
                   value={p.volume} 
                   onChange={(e) => handleVolumeChange(p.peerID, parseFloat(e.target.value))}
                   className="w-20 h-1 bg-zinc-600 rounded-lg appearance-none cursor-pointer accent-blue-500"
                 />
              </div>
            ))}
          </div>
        )}

        {/* ... Audio Players ... */}
      </div>

      {/* Screen Share Overlay - Using Username */}
      {incomingStreams.length > 0 && createPortal(
        <>
          {incomingStreams.map((item) => {
             const peer = peers.find(p => p.peerID === item.id);
             const name = peer ? peer.username : item.id.substring(0, 4);
             return (
                 <div key={item.id + item.stream.id} className="relative z-50">
                    <div className="absolute top-2 left-2 bg-black/60 px-2 py-1 rounded text-xs text-white z-50 pointer-events-none">
                        {name}'s Screen
                    </div>
                    <VideoPlayer stream={item.stream} />
                 </div>
             );
          })}
        </>,
        document.body
      )}
    </>
  );
}

const AudioPlayer = ({ peer, volume = 1 }: { peer: any, volume?: number }) => {
  const ref = useRef<HTMLAudioElement>(null);
  
  useEffect(() => {
    peer.on("stream", (stream: MediaStream) => {
      // Create a new stream with just the audio tracks to ensure clean playback
      const audioTracks = stream.getAudioTracks();
      if (audioTracks.length > 0) {
        const audioStream = new MediaStream(audioTracks);
        if (ref.current) {
          ref.current.srcObject = audioStream;
          ref.current.play().catch(e => console.error("Audio autoplay failed:", e));
        }
      }
    });
  }, [peer]);

  useEffect(() => {
    if (ref.current) {
      ref.current.volume = volume;
    }
  }, [volume]);

  return <audio ref={ref} autoPlay playsInline controls={false} style={{ display: 'none' }} />;
};

const VideoPlayer = ({ stream }: { stream: MediaStream }) => {
  const ref = useRef<HTMLVideoElement>(null);
  const [isExpanded, setIsExpanded] = useState(false);
  const [position, setPosition] = useState({ x: 20, y: 20 });
  const [isDragging, setIsDragging] = useState(false);
  const dragRef = useRef({ startX: 0, startY: 0, initialX: 0, initialY: 0 });

  useEffect(() => {
    if (ref.current) ref.current.srcObject = stream;
  }, [stream]);

  const handleMouseDown = (e: React.MouseEvent) => {
    // Only drag if not clicking controls (like expand button)
    if ((e.target as HTMLElement).tagName === 'BUTTON') return;
    
    setIsDragging(true);
    dragRef.current = {
      startX: e.clientX,
      startY: e.clientY,
      initialX: position.x,
      initialY: position.y
    };
  };

  useEffect(() => {
    const handleMouseMove = (e: MouseEvent) => {
      if (!isDragging) return;
      const dx = e.clientX - dragRef.current.startX;
      const dy = e.clientY - dragRef.current.startY;
      setPosition({
        x: dragRef.current.initialX - dx, // Inverted because right: 20px
        y: dragRef.current.initialY + dy
      });
    };

    const handleMouseUp = () => setIsDragging(false);

    if (isDragging) {
      window.addEventListener('mousemove', handleMouseMove);
      window.addEventListener('mouseup', handleMouseUp);
    }
    return () => {
      window.removeEventListener('mousemove', handleMouseMove);
      window.removeEventListener('mouseup', handleMouseUp);
    };
  }, [isDragging]);

  return (
    <div 
      className={`fixed z-50 bg-black rounded-lg overflow-hidden shadow-2xl border border-zinc-700 transition-all duration-200 ${
        isExpanded 
          ? "inset-4 w-auto h-auto cursor-default" 
          : "w-96 cursor-move hover:shadow-indigo-500/20"
      }`}
      style={!isExpanded ? { right: `${position.x}px`, top: `${position.y}px` } : {}}
      onMouseDown={!isExpanded ? handleMouseDown : undefined}
    >
      <div className="absolute top-2 right-2 z-20 flex gap-2">
        <button 
          onClick={() => setIsExpanded(!isExpanded)}
          className="p-1.5 bg-black/60 hover:bg-black/80 rounded text-white backdrop-blur-sm transition-colors"
        >
          {isExpanded ? (
            <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M8 3v3a2 2 0 0 1-2 2H3m18 0h-3a2 2 0 0 1-2-2V3m0 18v-3a2 2 0 0 1 2-2h3M3 16h3a2 2 0 0 1 2 2v3"/></svg>
          ) : (
            <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M15 3h6v6M9 21H3v-6M21 3l-7 7M3 21l7-7"/></svg>
          )}
        </button>
      </div>
      
      <video 
        ref={ref} 
        autoPlay 
        playsInline 
        className="w-full h-full object-contain bg-black"
      />
    </div>
  );
};
