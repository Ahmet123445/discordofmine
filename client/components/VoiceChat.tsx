"use client";

import { useEffect, useRef, useState, useCallback } from "react";
import { Socket } from "socket.io-client";
import { createPortal } from "react-dom";
import { DeepFilterNet3Processor } from "deepfilternet3-noise-filter";

interface VoiceChatProps {
  socket: Socket | null;
  roomId: string; // This is the Server ID (e.g. "gaming-1234")
  user: { id: number; username: string };
}

interface VoiceRoom {
  id: string; // Internal ID (e.g. "general")
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

  // SIMD Check Helper
  // const isSimdSupported = async () => { ... } // No longer needed for DeepFilterNet (WASM handles it)
  
  export default function VoiceChat({ socket, roomId: serverId, user }: VoiceChatProps) {
  const [inVoice, setInVoice] = useState(false);
  const [currentInternalRoomId, setCurrentInternalRoomId] = useState<string | null>(null);
  const [PeerClass, setPeerClass] = useState<any>(null);
  const [isSharingScreen, setIsSharingScreen] = useState(false);
  const [peers, setPeers] = useState<{ peerID: string; peer: any; volume: number; username: string }[]>([]);
  const [incomingStreams, setIncomingStreams] = useState<{ id: string; stream: MediaStream }[]>([]);
  const [hiddenStreams, setHiddenStreams] = useState<Set<string>>(new Set());
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
  
  // Default channels are "general" and "gaming"
  // These are SUB-CHANNELS inside the Server
  const [voiceRooms, setVoiceRooms] = useState<VoiceRoom[]>([
    { id: "general", name: "General" },
    { id: "gaming", name: "Gaming" },
  ]);
  
  // Map of FULL room IDs (server-internal) to users
  const [allRoomsUsers, setAllRoomsUsers] = useState<{ [roomId: string]: { id: string; username: string }[] }>({});

  const peersRef = useRef<{ peerID: string; peer: any }[]>([]);
  const localStream = useRef<MediaStream | null>(null);
  const screenStream = useRef<MediaStream | null>(null);
  
  // Audio Processing Refs
  const audioContextRef = useRef<AudioContext | null>(null);
  const deepFilterRef = useRef<DeepFilterNet3Processor | null>(null);
  const sourceNodeRef = useRef<MediaStreamAudioSourceNode | null>(null);
  const destinationNodeRef = useRef<MediaStreamAudioDestinationNode | null>(null);
  const gateIntervalRef = useRef<number | null>(null);

  const [noiseSuppressionEnabled, setNoiseSuppressionEnabled] = useState(true); // Default ON
  const [noiseSuppressionLoading, setNoiseSuppressionLoading] = useState(false);

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
    
    // Load noise suppression preference from localStorage (default: true)
    const savedNoiseSuppression = localStorage.getItem("noiseSuppressionEnabled");
    if (savedNoiseSuppression !== null) {
      setNoiseSuppressionEnabled(savedNoiseSuppression === "true");
    }
    
    import("simple-peer")
      .then((mod) => {
        setPeerClass(() => mod.default);
      })
      .catch((err) => {
        console.error("Failed to load simple-peer:", err);
      });
      
  }, []);

  // Listen for all rooms users updates
  useEffect(() => {
    if (!socket) return;
    
    const handleAllRoomsUsers = (data: { [roomId: string]: { id: string; username: string }[] }) => {
      setAllRoomsUsers(data);
    };
    
    socket.on("all-rooms-users", handleAllRoomsUsers);
    
    return () => {
      socket.off("all-rooms-users", handleAllRoomsUsers);
    };
  }, [socket]);

  // Handle socket reconnection - re-join voice if was connected
  useEffect(() => {
    if (!socket || !PeerClass) return;
    
    const handleReconnect = () => {
      console.log("VoiceChat: Socket reconnected");
      // If user was in a voice channel, re-join it
      if (inVoice && currentInternalRoomId) {
        console.log("VoiceChat: Re-joining voice channel after reconnect:", currentInternalRoomId);
        const namespacedRoomId = `${serverId}-${currentInternalRoomId}`;
        
        // Re-emit join-voice to restore server-side tracking
        socket.emit("join-voice", { roomId: namespacedRoomId, user });
      }
    };
    
    socket.on("reconnect", handleReconnect);
    
    return () => {
      socket.off("reconnect", handleReconnect);
    };
  }, [socket, PeerClass, inVoice, currentInternalRoomId, serverId, user]);

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

  useEffect(() => {
    return () => {
      cleanupAudioContext();
      if (localStream.current) {
        localStream.current.getTracks().forEach((t) => t.stop());
      }
    };
  }, []);
  
  const cleanupAudioContext = () => {
    if (gateIntervalRef.current) {
      window.cancelAnimationFrame(gateIntervalRef.current);
      gateIntervalRef.current = null;
    }
    if (deepFilterRef.current) {
      deepFilterRef.current.destroy();
      deepFilterRef.current = null;
    }
    if (sourceNodeRef.current) {
      sourceNodeRef.current.disconnect();
      sourceNodeRef.current = null;
    }
    if (destinationNodeRef.current) {
      destinationNodeRef.current.disconnect();
      destinationNodeRef.current = null;
    }
    if (audioContextRef.current && audioContextRef.current.state !== 'closed') {
      audioContextRef.current.close().catch(() => {});
      audioContextRef.current = null;
    }
  };

  const toggleMute = () => {
    // Toggle enabled on the tracks of the stream being sent (destination stream)
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

  // Toggle noise suppression on/off
  const toggleNoiseSuppression = useCallback(async () => {
    if (!inVoice || !audioContextRef.current || !deepFilterRef.current) {
       // Just update state if not connected
       const newValue = !noiseSuppressionEnabled;
       setNoiseSuppressionEnabled(newValue);
       localStorage.setItem("noiseSuppressionEnabled", String(newValue));
       return;
    }

    setNoiseSuppressionLoading(true);
    
    try {
      const newValue = !noiseSuppressionEnabled;
      
      console.log(`[VoiceChat] Toggling DeepFilterNet: ${newValue ? 'ON' : 'OFF'}`);
      
      // Use the internal bypass mechanism of DeepFilterNet
      deepFilterRef.current.setNoiseSuppressionEnabled(newValue);

      setNoiseSuppressionEnabled(newValue);
      localStorage.setItem("noiseSuppressionEnabled", String(newValue));
      
    } catch (error) {
      console.error("[VoiceChat] Failed to toggle noise suppression:", error);
    } finally {
      setNoiseSuppressionLoading(false);
    }
  }, [noiseSuppressionEnabled, inVoice]);

  useEffect(() => {
    // Re-render audio players when deafen state changes
  }, [isDeafened]);

  const joinVoice = async (internalRoomId: string) => {
    if (!socket || !PeerClass) return;
    if (inVoice) leaveVoice(); 

    playJoinSound();

    // Construct the unique Namespaced Room ID
    const namespacedRoomId = `${serverId}-${internalRoomId}`;

    try {
      // 1. Get raw microphone stream
      // We still want echo cancellation from the browser if possible
      const micStream = await navigator.mediaDevices.getUserMedia({ 
        video: false, 
        audio: {
          sampleRate: 48000,
          channelCount: 1,
          echoCancellation: true, // Keep hardware EC
          noiseSuppression: false, // RAW input for AI
          autoGainControl: false   // STABILITY: Disable browser AGC to prevent "sliding" quality
        } 
      });

      // 2. Set up Audio Context and Processing
      const audioCtx = new (window.AudioContext || (window as any).webkitAudioContext)({
        sampleRate: 48000,
        latencyHint: 'interactive'
      });
      audioContextRef.current = audioCtx;

      // --------------------------------------------------------
      // Premium Audio Chain Initialization
      // --------------------------------------------------------

      // A. High-Pass Filter (60Hz) - Removes sub-bass rumble without cutting vocal body
      const hpFilter = audioCtx.createBiquadFilter();
      hpFilter.type = "highpass";
      hpFilter.frequency.value = 60;

      // B. Pre-Gain - Boosts quiet voices before processing (Compensates for disabled AGC)
      const preGain = audioCtx.createGain();
      preGain.gain.value = 3.0; // Optimized gain (Loud enough but prevents distortion)

      // C. DeepFilterNet - AI Noise Suppression (Lite Mode for Performance)
      console.log("[VoiceChat] Initializing DeepFilterNet (Lite Mode - Performance Optimized)...");
      const processor = new DeepFilterNet3Processor({
          sampleRate: 48000,
          assetConfig: {
              cdnUrl: '/processors'
          },
          noiseReductionLevel: 30 // PERFORMANCE: Lower level significantly reduces CPU usage
      });
      await processor.initialize();
      const workletNode = await processor.createAudioWorkletNode(audioCtx);
      deepFilterRef.current = processor;
      processor.setNoiseSuppressionEnabled(noiseSuppressionEnabled);

      // D. Body EQ (Low-Mid Boost) - Adds warmth and richness using CPU-friendly nodes
      const bodyEQ = audioCtx.createBiquadFilter();
      bodyEQ.type = "peaking";
      bodyEQ.frequency.value = 350;
      bodyEQ.Q.value = 0.5; // Wider band for natural warmth
      bodyEQ.gain.value = 3.0; // +3dB boost

      // E. High-Shelf Filter (Air Boost) - Adds studio clarity
      const hsFilter = audioCtx.createBiquadFilter();
      hsFilter.type = "highshelf";
      hsFilter.frequency.value = 5000;
      hsFilter.gain.value = 4.0; // +4dB boost for air/presence

      // F. Dynamics Compressor - Soft leveling
      const compressor = audioCtx.createDynamicsCompressor();
      compressor.threshold.setValueAtTime(-20, audioCtx.currentTime);
      compressor.knee.setValueAtTime(40, audioCtx.currentTime); // Very soft knee
      compressor.ratio.setValueAtTime(3.0, audioCtx.currentTime); // Gentle compression
      compressor.attack.setValueAtTime(0.01, audioCtx.currentTime); // Slower attack for natural transients
      compressor.release.setValueAtTime(0.2, audioCtx.currentTime);

      // G. Post-Gain (Makeup Gain)
      const postGain = audioCtx.createGain();
      postGain.gain.value = 1.5; // Restore loudness

      // H. Smart Noise Gate (VAD) with Hold/Release
      // SENSITIVITY FIX: Move Analyser to the START of the chain (after preGain)
      const gateNode = audioCtx.createGain();
      const analyser = audioCtx.createAnalyser();
      analyser.fftSize = 512; // Smaller for even less CPU
      const bufferLength = analyser.frequencyBinCount;
      const dataArray = new Float32Array(bufferLength);
      
      let lastActiveTime = Date.now();
      let gateOpen = true;
      const threshold = -58; // SENSITIVITY: Much lower threshold (detects whispers)
      const holdTimeMs = 1200; // Longer hold for natural speech flow

      const updateGate = () => {
        if (!audioContextRef.current) return;
        analyser.getFloatTimeDomainData(dataArray);
        
        let sum = 0;
        for (let i = 0; i < dataArray.length; i++) {
          sum += dataArray[i] * dataArray[i];
        }
        const rms = Math.sqrt(sum / dataArray.length);
        const db = 20 * Math.log10(rms || 0.000001);

        const now = Date.now();
        if (db > threshold) {
          lastActiveTime = now;
          if (!gateOpen) {
            gateNode.gain.setTargetAtTime(1, audioCtx.currentTime, 0.05);
            gateOpen = true;
          }
        } else if (now - lastActiveTime > holdTimeMs) {
          if (gateOpen) {
            gateNode.gain.setTargetAtTime(0, audioCtx.currentTime, 0.5); // Very smooth fade-out
            gateOpen = false;
          }
        }
        gateIntervalRef.current = window.requestAnimationFrame(updateGate);
      };
      updateGate();

      // I. Peak Limiter - Prevents clipping
      const limiter = audioCtx.createDynamicsCompressor();
      limiter.threshold.setValueAtTime(-1, audioCtx.currentTime);
      limiter.knee.setValueAtTime(0, audioCtx.currentTime);
      limiter.ratio.setValueAtTime(20, audioCtx.currentTime);
      limiter.attack.setValueAtTime(0.001, audioCtx.currentTime);
      limiter.release.setValueAtTime(0.1, audioCtx.currentTime);

      // Create Nodes
      const source = audioCtx.createMediaStreamSource(micStream);
      sourceNodeRef.current = source;
      
      const destination = audioCtx.createMediaStreamDestination();
      destinationNodeRef.current = destination;

      // Connect Graph: 
      // Source -> HPF -> PreGain -> [ANALYSER BRANCH]
      //                     |
      //                     v
      //                  DFN -> BodyEQ -> AirEQ -> Compressor -> PostGain -> Gate -> Limiter -> Dest
      console.log("[VoiceChat] Connecting Studio Pro v4 (Gamer Edition) Audio Graph");
      
      source
        .connect(hpFilter)
        .connect(preGain);
      
      // Sensitivity Branch - V4.1 Force Trigger
      preGain.connect(analyser);
      
      // Audio Processing Branch
      preGain
        .connect(workletNode)
        .connect(bodyEQ)
        .connect(hsFilter)
        .connect(compressor)
        .connect(postGain)
        .connect(gateNode)
        .connect(limiter)
        .connect(destination);

      // Use the PROCESSED stream for peers
      const streamToUse = destination.stream;
      localStream.current = streamToUse;
      
      setInVoice(true);
      setCurrentInternalRoomId(internalRoomId);
      setIsMuted(false);

      // Join the namespaced room
      socket.emit("join-voice", { roomId: namespacedRoomId, user });

      socket.on("all-voice-users", (users: { id: string; username: string }[]) => {
        const peersArr: { peerID: string; peer: any; volume: number; username: string }[] = [];
        users.forEach((u) => {
          if (socket.id) {
            const peer = createPeer(u.id, socket.id, streamToUse, user.username);
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
        const peer = addPeer(payload.signal, payload.callerID, streamToUse);
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
    } catch (err) {
      console.error("Failed to get local stream", err);
      alert("Could not access microphone. Please allow permissions.");
    }
  };

  const leaveVoice = () => {
    if (!inVoice) return;

    playLeaveSound();
    stopScreenShare();
    setInVoice(false);
    setCurrentInternalRoomId(null);
    socket?.emit("leave-voice");

    localStream.current?.getTracks().forEach((track) => track.stop());
    localStream.current = null;
    
    // Clean up Audio Context
    cleanupAudioContext();

    peersRef.current.forEach((p) => p.peer.destroy());
    peersRef.current = [];
    setPeers([]);
    setIncomingStreams([]);
    setHiddenStreams(new Set());

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
      config: {
        iceServers: [
          { urls: "stun:stun.l.google.com:19302" },
          { urls: "stun:global.stun.twilio.com:3478" }
        ]
      }
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
      config: {
        iceServers: [
          { urls: "stun:stun.l.google.com:19302" },
          { urls: "stun:global.stun.twilio.com:3478" }
        ]
      }
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
    const audioTracks = stream.getAudioTracks();
    if (audioTracks.length > 0) {
      setPeers((prev) => {
        const updated = [...prev];
        const peerIndex = updated.findIndex((p) => p.peerID === id);
        if (peerIndex !== -1) {
          updated[peerIndex] = { ...updated[peerIndex] };
        }
        return updated;
      });
    }

    const videoTracks = stream.getVideoTracks();
    if (videoTracks.length > 0) {
      setIncomingStreams((prev) => {
        if (prev.find((s) => s.id === id && s.stream.id === stream.id)) return prev;
        return [...prev, { id, stream }];
      });
    }
  };

  const startScreenShare = () => {
    if (!PeerClass || !localStream.current) return;
    
    navigator.mediaDevices
      .getDisplayMedia({ 
        video: {
          width: { ideal: 1920 },
          height: { ideal: 1080 },
          frameRate: { ideal: 60 },
          cursor: "always"
        } as MediaTrackConstraints, 
        audio: true 
      })
      .then((stream: MediaStream) => {
        setIsSharingScreen(true);
        screenStream.current = stream;

        const videoTrack = stream.getVideoTracks()[0];
        const screenAudioTrack = stream.getAudioTracks()[0];
        
        // Create a combined stream with video + screen audio for VideoPlayer volume control
        // Microphone stays separate in AudioPlayer
        if (screenAudioTrack && videoTrack) {
          // Create a new stream with both video and screen audio
          const screenShareStream = new MediaStream([videoTrack, screenAudioTrack]);
          
          peersRef.current.forEach((p) => {
            // Add video track
            p.peer.addTrack(videoTrack, screenShareStream);
            // Add screen audio track separately (will create new stream on receiver)
            p.peer.addTrack(screenAudioTrack, screenShareStream);
          });
          
          console.log("Screen share started with screen audio (separate from mic)");
        } else if (videoTrack) {
          // No screen audio - just add video
          peersRef.current.forEach((p) => {
            p.peer.addTrack(videoTrack, stream);
          });
          console.log("Screen share started without screen audio");
        }

        if (videoTrack) {
          videoTrack.onended = () => {
            stopScreenShare();
          };
        }
      })
      .catch((err: any) => {
        console.error("Failed to share screen", err);
      });
  };

  const stopScreenShare = () => {
    if (!screenStream.current) return;
    
    // Stop all screen stream tracks
    screenStream.current.getTracks().forEach((track) => {
      track.stop();
      track.enabled = false;
    });

    // Remove video and screen audio tracks from peers
    peersRef.current.forEach((p) => {
      try {
        const senders = p.peer._pc?.getSenders?.() || [];
        senders.forEach((sender: RTCRtpSender) => {
          // Remove video tracks
          if (sender.track?.kind === 'video') {
            p.peer._pc?.removeTrack?.(sender);
          }
          // Remove screen audio tracks (not microphone)
          // Screen audio tracks have a different id than localStream audio
          if (sender.track?.kind === 'audio' && 
              sender.track.id !== localStream.current?.getAudioTracks()[0]?.id) {
            p.peer._pc?.removeTrack?.(sender);
          }
        });
      } catch (e) {
        console.error("Failed to remove screen share tracks:", e);
      }
    });

    // Clear incoming streams (for the sharer's own view)
    setIncomingStreams((prev) => {
      prev.forEach((s) => {
        s.stream.getTracks().forEach((track) => {
          track.stop();
          track.enabled = false;
        });
      });
      return [];
    });

    screenStream.current = null;
    setIsSharingScreen(false);
    console.log("Screen share stopped");
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
          {voiceRooms.map((room) => {
            const internalId = room.id;
            const namespacedId = `${serverId}-${internalId}`;
            const isMyRoom = currentInternalRoomId === internalId;
            const roomUsers = allRoomsUsers[namespacedId] || []; // LOOK UP BY FULL ID
            const otherRoomUsers = roomUsers.filter((u) => u.id !== socket?.id);
            
            return (
            <div key={internalId} className="group">
              <button
                onClick={() => (currentInternalRoomId === internalId ? leaveVoice() : joinVoice(internalId))}
                className={`w-full flex items-center gap-2 px-2 py-1.5 rounded text-sm transition-all ${
                  isMyRoom
                    ? "bg-zinc-700 text-white"
                    : "text-zinc-400 hover:text-zinc-200 hover:bg-zinc-800"
                }`}
              >
                <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={isMyRoom ? "text-green-400" : ""}>
                  <path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z"/>
                  <path d="M19 10v2a7 7 0 0 1-14 0v-2"/>
                </svg>
                <span>{room.name}</span>
                {roomUsers.length > 0 && (
                  <span className="ml-auto text-xs text-zinc-500">{roomUsers.length}</span>
                )}
                {isMyRoom && (
                  <span>
                    <span className="relative flex h-2 w-2">
                      <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-green-400 opacity-75"></span>
                      <span className="relative inline-flex rounded-full h-2 w-2 bg-green-500"></span>
                    </span>
                  </span>
                )}
              </button>
              
              {/* Show users in this room */}
              {isMyRoom && (
                <div className="ml-6 mt-1 space-y-1">
                  {/* Show myself first */}
                  <div className="flex items-center gap-2 text-xs py-0.5 px-1 rounded text-zinc-300">
                    <div className="w-5 h-5 rounded-full bg-gradient-to-br from-indigo-500 to-purple-600 flex items-center justify-center text-[10px] font-bold text-white">
                      {user.username[0].toUpperCase()}
                    </div>
                    <span className="flex-1 truncate">{user.username}</span>
                    <div className="flex items-center gap-1.5">
                      {/* Microphone status */}
                      {isMuted ? (
                        <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="text-red-500">
                          <line x1="1" y1="1" x2="23" y2="23"/><path d="M9 9v3a3 3 0 0 0 5.12 2.12M15 9.34V4a3 3 0 0 0-5.94-.6"/><path d="M19 10v2a7 7 0 0 1-14 0v-2"/>
                        </svg>
                      ) : (
                        <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="text-zinc-500">
                          <path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z"/><path d="M19 10v2a7 7 0 0 1-14 0v-2"/>
                        </svg>
                      )}
                      {/* Headphone/Deafen status */}
                      {isDeafened && (
                        <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="text-red-500">
                          <line x1="1" y1="1" x2="23" y2="23"/><path d="M3 14v-4a9 9 0 0 1 9-9v0"/><path d="M21 14v-4a9 9 0 0 0-9-9"/>
                        </svg>
                      )}
                      {/* Screen share status */}
                      {isSharingScreen && (
                        <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="text-indigo-400">
                          <rect x="2" y="3" width="20" height="14" rx="2" ry="2"/><line x1="8" y1="21" x2="16" y2="21"/><line x1="12" y1="17" x2="12" y2="21"/>
                        </svg>
                      )}
                      {/* Noise suppression status */}
                      {noiseSuppressionEnabled && (
                        <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="text-green-400">
                          <title>DeepFilterNet Suppression Active</title>
                          <path d="M2 10v3"/><path d="M6 6v11"/><path d="M10 3v18"/><path d="M14 8v7"/><path d="M18 5v13"/><path d="M22 10v3"/>
                        </svg>
                      )}
                    </div>
                  </div>
                  {/* Show other users in my room */}
                  {peers.map((p) => {
                    const isScreenSharing = incomingStreams.some((s) => s.id === p.peerID);
                    const streamItem = incomingStreams.find((s) => s.id === p.peerID);
                    const streamKey = streamItem ? `${streamItem.id}-${streamItem.stream.id}` : "";
                    const isHidden = hiddenStreams.has(streamKey);
                    
                    return (
                      <div key={p.peerID} className="flex items-center gap-2 text-xs py-0.5 px-1 rounded text-zinc-400">
                        <div className="w-5 h-5 rounded-full bg-gradient-to-br from-emerald-500 to-teal-600 flex items-center justify-center text-[10px] font-bold text-white">
                          {(p.username || "?")[0].toUpperCase()}
                        </div>
                        <span className="flex-1 truncate">{p.username || `User ${p.peerID.substring(0, 4)}`}</span>
                        <div className="flex items-center gap-1.5">
                          {/* Connected indicator */}
                          <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="text-green-500">
                            <path d="M3 18v-6a9 9 0 0 1 18 0v6"/><path d="M21 19a2 2 0 0 1-2 2h-1a2 2 0 0 1-2-2v-3a2 2 0 0 1 2-2h3zM3 19a2 2 0 0 0 2 2h1a2 2 0 0 0 2-2v-3a2 2 0 0 0-2-2H3z"/>
                          </svg>
                          {/* Screen share status - clickable to show/hide */}
                          {isScreenSharing && (
                            <button
                              onClick={(e) => {
                                e.stopPropagation();
                                if (isHidden) {
                                  setHiddenStreams((prev) => {
                                    const next = new Set(prev);
                                    next.delete(streamKey);
                                    return next;
                                  });
                                }
                              }}
                              className={`p-0.5 rounded transition-colors ${isHidden ? "text-zinc-500 hover:text-indigo-400" : "text-indigo-400"}`}
                              title={isHidden ? "Yayini Izle" : "Yayin Yapiliyor"}
                            >
                              <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                                <rect x="2" y="3" width="20" height="14" rx="2" ry="2"/><line x1="8" y1="21" x2="16" y2="21"/><line x1="12" y1="17" x2="12" y2="21"/>
                              </svg>
                            </button>
                          )}
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
              
              {/* Show users in other rooms (no speaking indicator) */}
              {!isMyRoom && otherRoomUsers.length > 0 && (
                <div className="ml-6 mt-1 space-y-1">
                  {otherRoomUsers.map((u) => (
                    <div key={u.id} className="flex items-center gap-2 text-xs text-zinc-500 py-0.5">
                      <div className="w-5 h-5 rounded-full bg-gradient-to-br from-zinc-600 to-zinc-700 flex items-center justify-center text-[10px] font-bold text-zinc-400">
                        {u.username[0].toUpperCase()}
                      </div>
                      <span className="flex-1 truncate">{u.username}</span>
                      <svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="text-zinc-600">
                        <path d="M3 18v-6a9 9 0 0 1 18 0v6"/><path d="M21 19a2 2 0 0 1-2 2h-1a2 2 0 0 1-2-2v-3a2 2 0 0 1 2-2h3zM3 19a2 2 0 0 0 2 2h1a2 2 0 0 0 2-2v-3a2 2 0 0 0-2-2H3z"/>
                      </svg>
                    </div>
                  ))}
                </div>
              )}
            </div>
          );
          })}
        </div>
      </div>

      {/* Voice Controls Panel (only when in voice) */}
      {inVoice && (
        <div className="p-3 bg-zinc-900/80 border-t border-zinc-700">
          <div className="flex items-center justify-between mb-2">
            <div className="flex items-center gap-2">
              <div className={`w-2 h-2 rounded-full ${isDeafened ? "bg-red-500" : "bg-green-500"} animate-pulse`}></div>
              <span className="text-xs text-zinc-300 font-medium">
                {isDeafened ? "Deafened" : isMuted ? "Muted" : "Connected (DeepFilterNet)"}
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
              onClick={toggleNoiseSuppression}
              disabled={noiseSuppressionLoading}
              className={`p-2.5 rounded-full transition-all ${
                noiseSuppressionLoading 
                  ? "bg-zinc-600 text-zinc-400 cursor-wait" 
                  : noiseSuppressionEnabled 
                    ? "bg-green-600 text-white" 
                    : "bg-zinc-700 text-zinc-300 hover:text-white hover:bg-zinc-600"
              }`}
              title={noiseSuppressionEnabled ? "Noise Suppression (DeepFilterNet): ON" : "Noise Suppression: OFF"}
            >
              {noiseSuppressionLoading ? (
                <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="animate-spin">
                  <path d="M21 12a9 9 0 1 1-6.219-8.56"/>
                </svg>
              ) : (
                <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M2 10v3"/>
                  <path d="M6 6v11"/>
                  <path d="M10 3v18"/>
                  <path d="M14 8v7"/>
                  <path d="M18 5v13"/>
                  <path d="M22 10v3"/>
                  {!noiseSuppressionEnabled && <line x1="1" y1="1" x2="23" y2="23" className="text-red-400"/>}
                </svg>
              )}
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
        <AudioPlayer
          key={p.peerID}
          peer={p.peer}
          volume={isDeafened ? 0 : p.volume / 100}
        />
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
              const streamKey = `${item.id}-${item.stream.id}`;
              
              // Skip if hidden
              if (hiddenStreams.has(streamKey)) return null;
              
              return (
                <VideoPlayer
                  key={streamKey}
                  stream={item.stream}
                  name={name}
                  onClose={() => {
                    // Just hide, don't stop the stream - allows re-watching
                    setHiddenStreams((prev) => new Set(prev).add(streamKey));
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

  useEffect(() => {
    const handler = (stream: MediaStream) => {
      // Ignore screen share streams (they have video tracks) - they are handled by VideoPlayer
      // Only handle microphone streams (audio only)
      if (stream.getVideoTracks().length > 0) return;

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
    
    // If peer already has remote streams (reconnection case)
    if (peer._remoteStreams && peer._remoteStreams.length > 0) {
      peer._remoteStreams.forEach((s: MediaStream) => handler(s));
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

  return (
    <div style={{ position: "absolute", top: 0, left: 0, width: 0, height: 0, overflow: "hidden", visibility: "hidden" }}>
      <audio ref={ref} autoPlay playsInline controls={false} />
    </div>
  );
};

const VideoPlayer = ({ stream, name, onClose }: { stream: MediaStream; name: string; onClose: () => void }) => {
  const ref = useRef<HTMLVideoElement>(null);
  const audioRef = useRef<HTMLAudioElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const [isExpanded, setIsExpanded] = useState(false);
  const [position, setPosition] = useState({ x: 20, y: 20 });
  const [size, setSize] = useState({ width: 400, height: 225 });
  const [isDragging, setIsDragging] = useState(false);
  const [isResizing, setIsResizing] = useState(false);
  const [hasAudio, setHasAudio] = useState(false);
  const [volume, setVolume] = useState(100);
  const dragRef = useRef({ startX: 0, startY: 0, initialX: 0, initialY: 0 });
  const resizeRef = useRef({ startX: 0, startY: 0, initialW: 0, initialH: 0 });

  useEffect(() => {
    if (ref.current) ref.current.srcObject = stream;
    
    // Check for audio tracks and play them
    const audioTracks = stream.getAudioTracks();
    if (audioTracks.length > 0 && audioRef.current) {
      const audioStream = new MediaStream(audioTracks);
      audioRef.current.srcObject = audioStream;
      audioRef.current.play().catch(() => {});
      setHasAudio(true);
    }
    
    // Cleanup when component unmounts or stream changes
    return () => {
      if (ref.current) {
        ref.current.srcObject = null;
      }
      if (audioRef.current) {
        audioRef.current.srcObject = null;
      }
    };
  }, [stream]);

  // Update audio volume when volume state changes
  useEffect(() => {
    if (audioRef.current) {
      audioRef.current.volume = volume / 100;
    }
  }, [volume]);

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
      
      <video ref={ref} autoPlay playsInline muted className="w-full h-full object-contain bg-black" />
      <audio ref={audioRef} autoPlay playsInline style={{ display: "none" }} />
      
      {/* Audio Volume Control */}
      {hasAudio && (
        <div className="absolute bottom-2 left-2 right-2 bg-black/70 px-3 py-2 rounded flex items-center gap-2 z-20">
          <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="text-green-400 flex-shrink-0">
            <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/>
            <path d="M15.54 8.46a5 5 0 0 1 0 7.07"/>
          </svg>
          <input
            type="range"
            min="0"
            max="100"
            value={volume}
            onChange={(e) => setVolume(parseInt(e.target.value))}
            className="flex-1 h-1 bg-zinc-600 rounded-lg appearance-none cursor-pointer accent-green-500"
            onClick={(e) => e.stopPropagation()}
            onMouseDown={(e) => e.stopPropagation()}
          />
          <span className="text-[10px] text-zinc-300 w-8 text-right font-mono">{volume}%</span>
        </div>
      )}
      
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
