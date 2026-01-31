"use client";

import { useEffect, useRef, useState } from "react";
import { Socket } from "socket.io-client";
import { createPortal } from "react-dom";

interface VoiceChatProps {
  socket: Socket | null;
  roomId: string;
  user: { id: number; username: string };
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

export default function VoiceChat({ socket, roomId, user }: VoiceChatProps) {
  const [inVoice, setInVoice] = useState(false);
  const [PeerClass, setPeerClass] = useState<any>(null);
  const [isSharingScreen, setIsSharingScreen] = useState(false);
  const [peers, setPeers] = useState<{ peerID: string; peer: any; volume: number; username: string }[]>([]);
  const [incomingStreams, setIncomingStreams] = useState<{ id: string; stream: MediaStream }[]>([]);
  const [isMuted, setIsMuted] = useState(false);
  const [mounted, setMounted] = useState(false);

  const peersRef = useRef<{ peerID: string; peer: any }[]>([]);
  const localStream = useRef<MediaStream | null>(null);
  const screenStream = useRef<MediaStream | null>(null);

  // Load Peer dynamically on mount
  useEffect(() => {
    setMounted(true);
    import("simple-peer").then((mod) => {
      setPeerClass(() => mod.default);
    }).catch((err) => {
      console.error("Failed to load simple-peer:", err);
    });
  }, []);

  // Keyboard Shortcuts
  useEffect(() => {
    if (!mounted) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.altKey && e.key.toLowerCase() === "m") {
        toggleMute();
      }
      if (e.altKey && e.key.toLowerCase() === "v") {
        if (inVoice) leaveVoice();
        else joinVoice();
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [inVoice, isMuted, mounted, PeerClass]);

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

  const joinVoice = () => {
    if (!socket || !PeerClass) return;

    playJoinSound();

    navigator.mediaDevices
      .getUserMedia({ video: false, audio: true })
      .then((stream) => {
        setInVoice(true);
        setIsMuted(false);
        localStream.current = stream;

        socket.emit("join-voice", { roomId, user });

        socket.on("all-voice-users", (users: { id: string; username: string }[]) => {
          const peersArr: { peerID: string; peer: any; volume: number; username: string }[] = [];
          users.forEach((u) => {
            if (socket.id) {
              const peer = createPeer(u.id, socket.id, stream, user.username);
              peersRef.current.push({ peerID: u.id, peer });
              peersArr.push({ peerID: u.id, peer, volume: 1.0, username: u.username });
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
          setPeers((prev) => [...prev, { peerID: payload.callerID, peer, volume: 1.0, username: payload.username }]);
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
    const isVideo = stream.getVideoTracks().length > 0;
    if (isVideo) {
      setIncomingStreams((prev) => {
        if (prev.find((s) => s.id === id && s.stream.id === stream.id)) return prev;
        return [...prev, { id, stream }];
      });
    }
  };

  const startScreenShare = () => {
    if (!PeerClass) return;
    // @ts-ignore
    navigator.mediaDevices
      .getDisplayMedia({ video: true, audio: false })
      .then((stream: MediaStream) => {
        setIsSharingScreen(true);
        screenStream.current = stream;

        peersRef.current.forEach((p) => {
          p.peer.addStream(stream);
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
    screenStream.current.getTracks().forEach((track) => track.stop());
    peersRef.current.forEach((p) => {
      if (screenStream.current) {
        try {
          p.peer.removeStream(screenStream.current);
        } catch (e) {}
      }
    });
    screenStream.current = null;
    setIsSharingScreen(false);
  };

  const handleVolumeChange = (peerId: string, newVolume: number) => {
    setPeers((prev) => prev.map((p) => (p.peerID === peerId ? { ...p, volume: newVolume } : p)));
  };

  if (!mounted) return null;

  return (
    <>
      <div className="p-3 bg-zinc-900 border-t border-zinc-700 flex flex-col gap-2">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <div className={`w-3 h-3 rounded-full ${inVoice ? "bg-green-500 animate-pulse" : "bg-red-500"}`}></div>
            <span className="text-xs text-zinc-400">
              {inVoice ? (isMuted ? "Voice (Muted)" : "Voice Connected") : "Disconnected"}
            </span>
            {inVoice && (
              <div className="text-[10px] text-zinc-600 ml-1 border border-zinc-700 px-1 rounded">ALT+M Mute</div>
            )}
          </div>

          <div className="flex gap-2">
            {inVoice && (
              <>
                <button
                  onClick={toggleMute}
                  className={`p-2 rounded-full transition-all ${isMuted ? "bg-red-600 text-white" : "bg-zinc-700 text-zinc-400 hover:text-white"}`}
                  title="Toggle Mute (ALT+M)"
                >
                  {isMuted ? (
                    <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><line x1="1" y1="1" x2="23" y2="23" /><path d="M9 9v3a3 3 0 0 0 5.12 2.12M15 9.34V4a3 3 0 0 0-5.94-.6" /></svg>
                  ) : (
                    <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z" /><path d="M19 10v2a7 7 0 0 1-14 0v-2" /><line x1="12" y1="19" x2="12" y2="23" /><line x1="8" y1="23" x2="16" y2="23" /></svg>
                  )}
                </button>

                <button
                  onClick={isSharingScreen ? stopScreenShare : startScreenShare}
                  className={`p-2 rounded-full transition-all ${isSharingScreen ? "bg-blue-600 text-white" : "bg-zinc-700 text-zinc-400 hover:text-white"}`}
                  title="Share Screen"
                >
                  <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="2" y="3" width="20" height="14" rx="2" ry="2" /><line x1="8" y1="21" x2="16" y2="21" /><line x1="12" y1="17" x2="12" y2="21" /></svg>
                </button>
              </>
            )}

            {inVoice ? (
              <button
                onClick={leaveVoice}
                className="p-2 rounded-full bg-red-600/20 text-red-500 hover:bg-red-600/40 transition-all"
                title="Disconnect (ALT+V)"
              >
                <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M10.68 13.31a16 16 0 0 0 3.41 2.6l1.27-1.27a2 2 0 0 1 2.11-.45 12.84 12.84 0 0 0 2.81.7 2 2 0 0 1 1.72 2v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.42 19.42 0 0 1-3.33-2.67m-2.67-3.34a19.79 19.79 0 0 1-3.07-8.63A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72 12.84 12.84 0 0 0 .7 2.81 2 2 0 0 1-.45 2.11L8.09 9.91" /><line x1="23" y1="1" x2="1" y2="23" /></svg>
              </button>
            ) : (
              <button
                onClick={joinVoice}
                className="p-2 rounded-full bg-green-600/20 text-green-500 hover:bg-green-600/40 transition-all"
                title="Join Voice (ALT+V)"
              >
                <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72 12.84 12.84 0 0 0 .7 2.81 2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45 12.84 12.84 0 0 0 2.81.7A2 2 0 0 1 22 16.92z" /></svg>
              </button>
            )}
          </div>
        </div>

        {inVoice && peers.length > 0 && (
          <div className="flex flex-col gap-1 mt-2 p-2 bg-zinc-800 rounded border border-zinc-700">
            <span className="text-[10px] uppercase text-zinc-500 font-bold mb-1">Voice Volume</span>
            {peers.map((p) => (
              <div key={p.peerID} className="flex items-center justify-between text-xs">
                <span className="text-zinc-300 w-20 truncate" title={p.username || p.peerID}>
                  {p.username || `User ${p.peerID.substring(0, 4)}`}
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

        {peers.map((p) => (
          <AudioPlayer key={p.peerID} peer={p.peer} volume={p.volume} />
        ))}
      </div>

      {mounted && incomingStreams.length > 0 &&
        createPortal(
          <>
            {incomingStreams.map((item) => {
              const peerData = peers.find((p) => p.peerID === item.id);
              const name = peerData ? peerData.username : item.id.substring(0, 4);
              return <VideoPlayer key={item.id + item.stream.id} stream={item.stream} name={name} />;
            })}
          </>,
          document.body
        )}
    </>
  );
}

const AudioPlayer = ({ peer, volume = 1 }: { peer: any; volume?: number }) => {
  const ref = useRef<HTMLAudioElement>(null);

  useEffect(() => {
    const handler = (stream: MediaStream) => {
      const audioTracks = stream.getAudioTracks();
      if (audioTracks.length > 0) {
        const audioStream = new MediaStream(audioTracks);
        if (ref.current) {
          ref.current.srcObject = audioStream;
          ref.current.play().catch(() => {});
        }
      }
    };
    peer.on("stream", handler);
    return () => {
      peer.off("stream", handler);
    };
  }, [peer]);

  useEffect(() => {
    if (ref.current) {
      ref.current.volume = volume;
    }
  }, [volume]);

  return <audio ref={ref} autoPlay playsInline style={{ display: "none" }} />;
};

const VideoPlayer = ({ stream, name }: { stream: MediaStream; name: string }) => {
  const ref = useRef<HTMLVideoElement>(null);
  const [isExpanded, setIsExpanded] = useState(false);
  const [position, setPosition] = useState({ x: 20, y: 20 });
  const [isDragging, setIsDragging] = useState(false);
  const dragRef = useRef({ startX: 0, startY: 0, initialX: 0, initialY: 0 });

  useEffect(() => {
    if (ref.current) ref.current.srcObject = stream;
  }, [stream]);

  const handleMouseDown = (e: React.MouseEvent) => {
    if ((e.target as HTMLElement).tagName === "BUTTON") return;
    setIsDragging(true);
    dragRef.current = {
      startX: e.clientX,
      startY: e.clientY,
      initialX: position.x,
      initialY: position.y,
    };
  };

  useEffect(() => {
    const handleMouseMove = (e: MouseEvent) => {
      if (!isDragging) return;
      const dx = e.clientX - dragRef.current.startX;
      const dy = e.clientY - dragRef.current.startY;
      setPosition({
        x: dragRef.current.initialX - dx,
        y: dragRef.current.initialY + dy,
      });
    };
    const handleMouseUp = () => setIsDragging(false);

    if (isDragging) {
      window.addEventListener("mousemove", handleMouseMove);
      window.addEventListener("mouseup", handleMouseUp);
    }
    return () => {
      window.removeEventListener("mousemove", handleMouseMove);
      window.removeEventListener("mouseup", handleMouseUp);
    };
  }, [isDragging]);

  return (
    <div
      className={`fixed z-50 bg-black rounded-lg overflow-hidden shadow-2xl border border-zinc-700 transition-all duration-200 ${
        isExpanded ? "inset-4 w-auto h-auto cursor-default" : "w-96 cursor-move hover:shadow-indigo-500/20"
      }`}
      style={!isExpanded ? { right: `${position.x}px`, top: `${position.y}px` } : {}}
      onMouseDown={!isExpanded ? handleMouseDown : undefined}
    >
      <div className="absolute top-2 left-2 bg-black/60 px-2 py-1 rounded text-xs text-white z-20 pointer-events-none">
        {name}&apos;s Screen
      </div>
      <div className="absolute top-2 right-2 z-20 flex gap-2">
        <button
          onClick={() => setIsExpanded(!isExpanded)}
          className="p-1.5 bg-black/60 hover:bg-black/80 rounded text-white backdrop-blur-sm transition-colors"
        >
          {isExpanded ? (
            <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M8 3v3a2 2 0 0 1-2 2H3m18 0h-3a2 2 0 0 1-2-2V3m0 18v-3a2 2 0 0 1 2-2h3M3 16h3a2 2 0 0 1 2 2v3" /></svg>
          ) : (
            <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M15 3h6v6M9 21H3v-6M21 3l-7 7M3 21l7-7" /></svg>
          )}
        </button>
      </div>
      <video ref={ref} autoPlay playsInline className="w-full h-full object-contain bg-black" />
    </div>
  );
};
