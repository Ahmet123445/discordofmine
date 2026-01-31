"use client";

import { useEffect, useRef, useState } from "react";
import Peer from "simple-peer";
import { Socket } from "socket.io-client";
import { createPortal } from "react-dom";

interface VoiceChatProps {
  socket: Socket | null;
  roomId: string;
  user: { id: number; username: string };
}

// Sound effects
const playJoinSound = () => {
  const audio = new Audio("/sounds/join.mp3");
  audio.volume = 0.5;
  audio.play().catch(e => console.log("Audio play failed (user interaction needed first)", e));
};

const playLeaveSound = () => {
  const audio = new Audio("/sounds/leave.mp3");
  audio.volume = 0.5;
  audio.play().catch(e => console.log("Audio play failed", e));
};

export default function VoiceChat({ socket, roomId, user }: VoiceChatProps) {
  const [inVoice, setInVoice] = useState(false);
  const [isSharingScreen, setIsSharingScreen] = useState(false);
  const [peers, setPeers] = useState<{ peerID: string, peer: Peer.Instance, volume: number }[]>([]);
  const [incomingStreams, setIncomingStreams] = useState<{ id: string, stream: MediaStream }[]>([]);
  const [isMuted, setIsMuted] = useState(false);
  
  const userAudio = useRef<HTMLAudioElement>(null);
  const peersRef = useRef<{ peerID: string; peer: Peer.Instance }[]>([]);
  const localStream = useRef<MediaStream | null>(null);
  const screenStream = useRef<MediaStream | null>(null);

  // Keyboard Shortcuts
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      // ALT + M -> Toggle Mute
      if (e.altKey && e.key.toLowerCase() === 'm') {
        toggleMute();
      }
      // ALT + V -> Toggle Voice (Join/Leave)
      if (e.altKey && e.key.toLowerCase() === 'v') {
        if (inVoice) leaveVoice();
        else joinVoice();
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [inVoice, isMuted]); // Re-bind when state changes

  // Clean up on unmount
  useEffect(() => {
    return () => {
      leaveVoice();
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
    if (!socket) return;
    
    playJoinSound();

    navigator.mediaDevices.getUserMedia({ video: false, audio: true })
      .then(stream => {
        setInVoice(true);
        setIsMuted(false);
        localStream.current = stream;
        
        socket.emit("join-voice", roomId);

        socket.on("all-voice-users", (users: string[]) => {
          const peersArr: { peerID: string, peer: Peer.Instance, volume: number }[] = [];
          users.forEach(userID => {
            const peer = createPeer(userID, socket.id, stream);
            peersRef.current.push({ peerID: userID, peer });
            peersArr.push({ peerID: userID, peer, volume: 1.0 });
          });
          setPeers(peersArr);
        });

        socket.on("user-joined-voice", (payload: { signal: any, callerID: string }) => {
          playJoinSound();
          const peer = addPeer(payload.signal, payload.callerID, stream);
          peersRef.current.push({ peerID: payload.callerID, peer });
          setPeers(users => [...users, { peerID: payload.callerID, peer, volume: 1.0 }]);
        });

        socket.on("receiving-returned-signal", (payload: { signal: any, id: string }) => {
          const item = peersRef.current.find(p => p.peerID === payload.id);
          if (item) {
            item.peer.signal(payload.signal);
          }
        });

        socket.on("user-left-voice", (id: string) => {
           playLeaveSound();
           const peerObj = peersRef.current.find(p => p.peerID === id);
           if(peerObj) peerObj.peer.destroy();
           
           const newPeers = peersRef.current.filter(p => p.peerID !== id);
           peersRef.current = newPeers;
           setPeers(prev => prev.filter(p => p.peerID !== id));
           setIncomingStreams(prev => prev.filter(s => s.id !== id));
        });
      })
      .catch(err => {
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
    
    localStream.current?.getTracks().forEach(track => track.stop());
    localStream.current = null;

    peersRef.current.forEach(p => p.peer.destroy());
    peersRef.current = [];
    setPeers([]);
    setIncomingStreams([]);

    socket?.off("all-voice-users");
    socket?.off("user-joined-voice");
    socket?.off("receiving-returned-signal");
    socket?.off("user-left-voice");
  };

  const createPeer = (userToSignal: string, callerID: string, stream: MediaStream) => {
    const peer = new Peer({
      initiator: true,
      trickle: false,
      stream,
    });

    peer.on("signal", signal => {
      socket?.emit("sending-signal", { userToSignal, callerID, signal });
    });

    peer.on("stream", (remoteStream) => {
      handleIncomingStream(userToSignal, remoteStream);
    });

    return peer;
  };

  const addPeer = (incomingSignal: any, callerID: string, stream: MediaStream) => {
    const peer = new Peer({
      initiator: false,
      trickle: false,
      stream,
    });

    peer.on("signal", signal => {
      socket?.emit("returning-signal", { signal, callerID });
    });

    peer.on("stream", (remoteStream) => {
      handleIncomingStream(callerID, remoteStream);
    });

    peer.signal(incomingSignal);

    return peer;
  };

  const handleIncomingStream = (id: string, stream: MediaStream) => {
    const isVideo = stream.getVideoTracks().length > 0;
    
    if (isVideo) {
      setIncomingStreams(prev => {
        if (prev.find(s => s.id === id && s.stream.id === stream.id)) return prev;
        return [...prev, { id, stream }];
      });
    }
  };

  const startScreenShare = () => {
    // @ts-ignore
    navigator.mediaDevices.getDisplayMedia({ cursor: true })
      .then((stream: MediaStream) => {
        setIsSharingScreen(true);
        screenStream.current = stream;

        peersRef.current.forEach(p => {
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
    screenStream.current.getTracks().forEach(track => track.stop());
    peersRef.current.forEach(p => {
      if (screenStream.current) {
        p.peer.removeStream(screenStream.current);
      }
    });
    screenStream.current = null;
    setIsSharingScreen(false);
  };

  const handleVolumeChange = (peerId: string, newVolume: number) => {
    setPeers(prev => prev.map(p => 
      p.peerID === peerId ? { ...p, volume: newVolume } : p
    ));
  };

  return (
    <>
      {/* Voice Controls & User List */}
      <div className="p-3 bg-zinc-900 border-t border-zinc-700 flex flex-col gap-2">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
             <div className={`w-3 h-3 rounded-full ${inVoice ? 'bg-green-500 animate-pulse' : 'bg-red-500'}`}></div>
             <span className="text-xs text-zinc-400">
                {inVoice ? (isMuted ? "Voice (Muted)" : "Voice Connected") : "Disconnected"}
             </span>
             {inVoice && (
                <div className="text-[10px] text-zinc-600 ml-1 border border-zinc-700 px-1 rounded">
                  ALT+M Mute
                </div>
             )}
          </div>
          
          <div className="flex gap-2">
            {inVoice && (
              <>
                 <button 
                  onClick={toggleMute}
                  className={`p-2 rounded-full transition-all ${isMuted ? 'bg-red-600 text-white' : 'bg-zinc-700 text-zinc-400 hover:text-white'}`}
                  title="Toggle Mute (ALT+M)"
                >
                  {isMuted ? (
                    <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><line x1="1" y1="1" x2="23" y2="23"/><path d="M9 9v3a3 3 0 0 0 5.12 2.12M15 9.34V4a3 3 0 0 0-5.94-.6"/></svg>
                  ) : (
                    <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z"/><path d="M19 10v2a7 7 0 0 1-14 0v-2"/><line x1="12" y1="19" x2="12" y2="23"/><line x1="8" y1="23" x2="16" y2="23"/></svg>
                  )}
                </button>

                <button 
                  onClick={isSharingScreen ? stopScreenShare : startScreenShare}
                  className={`p-2 rounded-full transition-all ${isSharingScreen ? 'bg-blue-600 text-white' : 'bg-zinc-700 text-zinc-400 hover:text-white'}`}
                  title="Share Screen"
                >
                  <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="2" y="3" width="20" height="14" rx="2" ry="2"/><line x1="8" y1="21" x2="16" y2="21"/><line x1="12" y1="17" x2="12" y2="21"/></svg>
                </button>
              </>
            )}

            {inVoice ? (
               <button 
                 onClick={leaveVoice}
                 className="p-2 rounded-full bg-red-600/20 text-red-500 hover:bg-red-600/40 transition-all"
                 title="Disconnect (ALT+V)"
               >
                 <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M10.68 13.31a16 16 0 0 0 3.41 2.6l1.27-1.27a2 2 0 0 1 2.11-.45 12.84 12.84 0 0 0 2.81.7 2 2 0 0 1 1.72 2v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.42 19.42 0 0 1-3.33-2.67m-2.67-3.34a19.79 19.79 0 0 1-3.07-8.63A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72 12.84 12.84 0 0 0 .7 2.81 2 2 0 0 1-.45 2.11L8.09 9.91"/><line x1="23" y1="1" x2="1" y2="23"/></svg>
               </button>
            ) : (
               <button 
                 onClick={joinVoice}
                 className="p-2 rounded-full bg-green-600/20 text-green-500 hover:bg-green-600/40 transition-all"
                 title="Join Voice (ALT+V)"
               >
                 <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72 12.84 12.84 0 0 0 .7 2.81 2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45 12.84 12.84 0 0 0 2.81.7A2 2 0 0 1 22 16.92z"/></svg>
               </button>
            )}
          </div>
        </div>

        {/* Volume Controls for Peers */}
        {inVoice && peers.length > 0 && (
          <div className="flex flex-col gap-1 mt-2 p-2 bg-zinc-800 rounded border border-zinc-700">
            <span className="text-[10px] uppercase text-zinc-500 font-bold mb-1">Voice Volume</span>
            {peers.map((p) => (
              <div key={p.peerID} className="flex items-center justify-between text-xs">
                 <span className="text-zinc-300 w-16 truncate" title={p.peerID}>User {p.peerID.substring(0,4)}</span>
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

        {/* Hidden Audio Elements for Peers (Voice) */}
        {peers.map((p) => (
          <AudioPlayer key={p.peerID} peer={p.peer} volume={p.volume} />
        ))}
      </div>

      {/* Screen Share Overlay */}
      {incomingStreams.length > 0 && createPortal(
        <div className="fixed top-4 right-4 z-50 flex flex-col gap-4 w-96 max-w-[90vw]">
          {incomingStreams.map((item) => (
            <div key={item.id + item.stream.id} className="bg-zinc-800 rounded-lg overflow-hidden border border-zinc-700 shadow-2xl relative">
              <div className="absolute top-2 left-2 bg-black/60 px-2 py-1 rounded text-xs text-white z-10">
                User {item.id.substring(0, 4)}...
              </div>
              <VideoPlayer stream={item.stream} />
            </div>
          ))}
        </div>,
        document.body
      )}
    </>
  );
}

const AudioPlayer = ({ peer, volume = 1 }: { peer: Peer.Instance, volume?: number }) => {
  const ref = useRef<HTMLAudioElement>(null);
  useEffect(() => {
    peer.on("stream", (stream: MediaStream) => {
      if (stream.getAudioTracks().length > 0) {
        if (ref.current) ref.current.srcObject = stream;
      }
    });
  }, [peer]);

  useEffect(() => {
    if (ref.current) {
      ref.current.volume = volume;
    }
  }, [volume]);

  return <audio ref={ref} autoPlay />;
};

const VideoPlayer = ({ stream }: { stream: MediaStream }) => {
  const ref = useRef<HTMLVideoElement>(null);
  useEffect(() => {
    if (ref.current) ref.current.srcObject = stream;
  }, [stream]);
  return <video ref={ref} autoPlay playsInline className="w-full h-auto bg-black" />;
};
