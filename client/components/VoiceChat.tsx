"use client";

import { useEffect, useRef, useState, useCallback } from "react";
import { Socket } from "socket.io-client";
import { createPortal } from "react-dom";
import { DeepFilterNet3Processor } from "deepfilternet3-noise-filter";

interface VoiceChatProps {
  socket: Socket | null;
  roomId: string; // This is the Server ID (e.g. "gaming-1234")
  user: { id: number; username: string };
  roomCreatorId?: number | null;
  onKickUser?: (target: { id: number; username: string }) => void;
}

interface VoiceUser {
  id: string;
  username: string;
  userId?: number | null;
}

interface VoiceRoom {
  id: string; // Internal ID (e.g. "general")
  name: string;
}

const CrownIcon = ({ className = "" }: { className?: string }) => (
  <svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={className}>
    <path d="m2 5 5 5 5-8 5 8 5-5-2 14H4L2 5z"/>
    <path d="M4 19h16"/>
  </svg>
);

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

const playScreenStartSound = () => {
  if (typeof window === "undefined") return;

  try {
    const ctx = new AudioContext();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();

    osc.type = "triangle";
    osc.frequency.setValueAtTime(920, ctx.currentTime);
    osc.frequency.exponentialRampToValueAtTime(700, ctx.currentTime + 0.16);

    gain.gain.setValueAtTime(0.0001, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.08, ctx.currentTime + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + 0.16);

    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.start(ctx.currentTime);
    osc.stop(ctx.currentTime + 0.17);
    osc.onended = () => ctx.close();
  } catch {
    // Ignore audio failures silently
  }
};

const DEFAULT_ICE_SERVERS = [
  { urls: "stun:stun.l.google.com:19302" },
  { urls: "stun:global.stun.twilio.com:3478" },
  { urls: "turn:openrelay.metered.ca:80", username: "openrelayproject", credential: "openrelayproject" },
  { urls: "turn:openrelay.metered.ca:443", username: "openrelayproject", credential: "openrelayproject" },
  { urls: "turn:openrelay.metered.ca:443?transport=tcp", username: "openrelayproject", credential: "openrelayproject" }
];

const parseIceServers = () => {
  const custom = (process.env.NEXT_PUBLIC_ICE_SERVERS_JSON || "").trim();
  if (custom) {
    try {
      const parsed = JSON.parse(custom);
      if (Array.isArray(parsed) && parsed.length > 0) {
        return parsed;
      }
    } catch (err) {
      console.error("ICE server parse hatasi", err);
    }
  }

  const turnUrls = (process.env.NEXT_PUBLIC_TURN_URL || "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);

  if (turnUrls.length === 0) {
    return DEFAULT_ICE_SERVERS;
  }

  const username = process.env.NEXT_PUBLIC_TURN_USERNAME || "";
  const credential = process.env.NEXT_PUBLIC_TURN_PASSWORD || "";

  return [
    ...DEFAULT_ICE_SERVERS,
    ...turnUrls.map((urls) => ({ urls, username, credential }))
  ];
};

const ICE_SERVERS = parseIceServers();
const PEER_DISCONNECTED_GRACE_MS = 8000;
const PEER_LIVENESS_INTERVAL_MS = 5000;
const PEER_AUDIO_STALL_MS = 30000;
const AUDIO_PLAYBACK_RESUME_INTERVAL_MS = 5000;
const RECONNECT_DEBOUNCE_MS = 2000;
const isBotPeerId = (peerID: string) => peerID.startsWith("music-bot:") || peerID.startsWith("radio-bot:");

  // SIMD Check Helper
  // const isSimdSupported = async () => { ... } // No longer needed for DeepFilterNet (WASM handles it)
  
  export default function VoiceChat({ socket, roomId: serverId, user, roomCreatorId, onKickUser }: VoiceChatProps) {
  const [inVoice, setInVoice] = useState(false);
  const [currentInternalRoomId, setCurrentInternalRoomId] = useState<string | null>(null);
  const [PeerClass, setPeerClass] = useState<any>(null);
  const [isSharingScreen, setIsSharingScreen] = useState(false);
  const [peers, setPeers] = useState<{ peerID: string; peer: any; volume: number; username: string; userId?: number | null }[]>([]);
  const [remoteAudioStreams, setRemoteAudioStreams] = useState<{ id: string; stream: MediaStream }[]>([]);
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
  const [allRoomsUsers, setAllRoomsUsers] = useState<{ [roomId: string]: VoiceUser[] }>({});

  const peersRef = useRef<{ peerID: string; peer: any }[]>([]);
  const peerUserDetailsRef = useRef<Map<string, VoiceUser>>(new Map());
  const localStream = useRef<MediaStream | null>(null);
  const screenStream = useRef<MediaStream | null>(null);
  
  // Audio Processing Refs
  const audioContextRef = useRef<AudioContext | null>(null);
  const deepFilterRef = useRef<DeepFilterNet3Processor | null>(null);
  const sourceNodeRef = useRef<MediaStreamAudioSourceNode | null>(null);
  const destinationNodeRef = useRef<MediaStreamAudioDestinationNode | null>(null);
  const gateIntervalRef = useRef<number | null>(null);
  const announcedScreenStreamsRef = useRef<Set<string>>(new Set());
  const resettingRemotePeersRef = useRef(false);
  const rejoinTimerRef = useRef<number | null>(null);
  const replacePeersOnNextJoinRef = useRef(false);
  const peerDisconnectTimersRef = useRef<Map<string, number>>(new Map());
  const peerHealthTimersRef = useRef<Map<string, number>>(new Map());
  const peerReconnectTimersRef = useRef<Map<string, number>>(new Map());
  const peerAudioStatsRef = useRef<Map<string, { bytes: number; packets: number; stalledSince: number | null }>>(new Map());
  const peerRecoveryCooldownRef = useRef<Map<string, number>>(new Map());
  const reconnectDebounceTimerRef = useRef<number | null>(null);
  const lastReconnectAtRef = useRef<number>(0);

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
    
    const handleAllRoomsUsers = (data: { [roomId: string]: VoiceUser[] }) => {
      setAllRoomsUsers(data);
    };
    
    socket.on("all-rooms-users", handleAllRoomsUsers);
    
    return () => {
      socket.off("all-rooms-users", handleAllRoomsUsers);
    };
  }, [socket]);

  const isPeerUsable = (peer: any) => {
    if (!peer || peer.destroyed) return false;
    const pc: RTCPeerConnection | undefined = peer?._pc;
    if (!pc) return true;

    return !["closed", "failed"].includes(pc.connectionState) &&
      !["closed", "failed"].includes(pc.iceConnectionState);
  };

  const clearPeerRecoveryTimers = useCallback((peerID: string) => {
    const disconnectTimer = peerDisconnectTimersRef.current.get(peerID);
    if (disconnectTimer) {
      window.clearTimeout(disconnectTimer);
      peerDisconnectTimersRef.current.delete(peerID);
    }

    const healthTimer = peerHealthTimersRef.current.get(peerID);
    if (healthTimer) {
      window.clearInterval(healthTimer);
      peerHealthTimersRef.current.delete(peerID);
    }

    const reconnectTimer = peerReconnectTimersRef.current.get(peerID);
    if (reconnectTimer) {
      window.clearTimeout(reconnectTimer);
      peerReconnectTimersRef.current.delete(peerID);
    }

    const iceTimeoutKey = `${peerID}-ice-timeout`;
    const iceTimeout = peerHealthTimersRef.current.get(iceTimeoutKey);
    if (iceTimeout) {
      window.clearTimeout(iceTimeout);
      peerHealthTimersRef.current.delete(iceTimeoutKey);
    }

    peerAudioStatsRef.current.delete(peerID);
  }, []);

  const clearAllPeerRecoveryTimers = useCallback(() => {
    peerDisconnectTimersRef.current.forEach((timer) => window.clearTimeout(timer));
    peerHealthTimersRef.current.forEach((timer) => window.clearTimeout(timer));
    peerReconnectTimersRef.current.forEach((timer) => window.clearTimeout(timer));
    peerDisconnectTimersRef.current.clear();
    peerHealthTimersRef.current.clear();
    peerReconnectTimersRef.current.clear();
    peerAudioStatsRef.current.clear();
    peerRecoveryCooldownRef.current.clear();
  }, []);

  const removeRemotePeer = useCallback((peerID: string, destroyPeer = true) => {
    const existing = peersRef.current.find((p) => p.peerID === peerID);
    if (destroyPeer && existing) {
      try {
        resettingRemotePeersRef.current = true;
        existing.peer.__intentionalDestroy = true;
        existing.peer.destroy();
      } catch {
        // Ignore peer teardown errors during recovery.
      } finally {
        resettingRemotePeersRef.current = false;
      }
    }

    clearPeerRecoveryTimers(peerID);
    peersRef.current = peersRef.current.filter((p) => p.peerID !== peerID);
    setPeers((prev) => prev.filter((p) => p.peerID !== peerID));
    setRemoteAudioStreams((prev) => prev.filter((s) => s.id !== peerID));
    setIncomingStreams((prev) => prev.filter((s) => s.id !== peerID));
    announcedScreenStreamsRef.current.forEach((key) => {
      if (key.startsWith(`${peerID}-`)) {
        announcedScreenStreamsRef.current.delete(key);
      }
    });
  }, [clearPeerRecoveryTimers]);

  const resetRemotePeers = useCallback(() => {
    resettingRemotePeersRef.current = true;
    peersRef.current.forEach((p) => {
      try {
        p.peer.__intentionalDestroy = true;
        p.peer.destroy();
      } catch {
        // Ignore peer teardown errors during recovery.
      }
    });
    resettingRemotePeersRef.current = false;

    clearAllPeerRecoveryTimers();
    peersRef.current = [];
    peerUserDetailsRef.current.clear();
    setPeers([]);
    setRemoteAudioStreams([]);
    setIncomingStreams([]);
    setHiddenStreams(new Set());
    announcedScreenStreamsRef.current.clear();
  }, [clearAllPeerRecoveryTimers]);

  const rejoinCurrentVoice = useCallback((reason: string) => {
    if (!socket || !inVoice || !currentInternalRoomId || !localStream.current) return;
    if (rejoinTimerRef.current) return;

    const now = Date.now();
    if (now - lastReconnectAtRef.current < RECONNECT_DEBOUNCE_MS) {
      console.log(`VoiceChat: Skipping rejoin (debounced) after ${reason}`);
      return;
    }
    lastReconnectAtRef.current = now;

    rejoinTimerRef.current = window.setTimeout(() => {
      rejoinTimerRef.current = null;
      if (!socket.connected || !localStream.current) return;

      console.log(`VoiceChat: Re-joining voice after ${reason}:`, currentInternalRoomId);
      replacePeersOnNextJoinRef.current = true;
      resetRemotePeers();
      socket.emit("join-voice", { roomId: `${serverId}-${currentInternalRoomId}`, user, forcePeerRefresh: true });
      socket.emit("heartbeat", { roomId: `${serverId}-${currentInternalRoomId}` });
    }, 250);
  }, [socket, inVoice, currentInternalRoomId, resetRemotePeers, serverId, user]);

  // Handle socket reconnection - rebuild remote peers instead of reusing stale WebRTC state.
  useEffect(() => {
    if (!socket || !PeerClass) return;
    
    const handleReconnect = () => {
      const now = Date.now();
      if (now - lastReconnectAtRef.current < RECONNECT_DEBOUNCE_MS) {
        console.log("VoiceChat: Skipping reconnect event (debounced)");
        return;
      }
      rejoinCurrentVoice("socket reconnect");
    };
    
    socket.on("connect", handleReconnect);
    socket.on("reconnect", handleReconnect);
    socket.io?.on("reconnect", handleReconnect);
    
    return () => {
      socket.off("connect", handleReconnect);
      socket.off("reconnect", handleReconnect);
      socket.io?.off("reconnect", handleReconnect);
      if (reconnectDebounceTimerRef.current) {
        window.clearTimeout(reconnectDebounceTimerRef.current);
        reconnectDebounceTimerRef.current = null;
      }
    };
  }, [socket, PeerClass, rejoinCurrentVoice]);

  // CRITICAL: Heartbeat to keep session alive in database
  // Sends every 30 seconds to prevent stale session cleanup
  useEffect(() => {
    if (!socket || !inVoice || !currentInternalRoomId) return;
    
    const namespacedRoomId = `${serverId}-${currentInternalRoomId}`;
    
    // Send heartbeat immediately on join
    socket.emit("heartbeat", { roomId: namespacedRoomId });
    
    // Then send every 30 seconds
    const interval = setInterval(() => {
      socket.emit("heartbeat", { roomId: namespacedRoomId });
    }, 30000);
    
    return () => clearInterval(interval);
  }, [socket, inVoice, currentInternalRoomId, serverId]);

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
      if (rejoinTimerRef.current) {
        window.clearTimeout(rejoinTimerRef.current);
        rejoinTimerRef.current = null;
      }
      if (reconnectDebounceTimerRef.current) {
        window.clearTimeout(reconnectDebounceTimerRef.current);
        reconnectDebounceTimerRef.current = null;
      }
      clearAllPeerRecoveryTimers();
      cleanupAudioContext();
      if (localStream.current) {
        localStream.current.getTracks().forEach((t) => t.stop());
      }
    };
  }, [clearAllPeerRecoveryTimers]);

  useEffect(() => {
    if (!inVoice) return;

    const handleBeforeUnload = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = "";
      return "";
    };

    window.addEventListener("beforeunload", handleBeforeUnload);
    return () => {
      window.removeEventListener("beforeunload", handleBeforeUnload);
    };
  }, [inVoice]);
  
  const cleanupAudioContext = () => {
    if (gateIntervalRef.current) {
      window.clearInterval(gateIntervalRef.current);
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
        
        // Sync the enabled state to all cloned tracks being sent to peers
        peersRef.current.forEach((p) => {
          try {
            const pc: RTCPeerConnection | undefined = p.peer?._pc;
            if (pc && typeof pc.getSenders === "function") {
              pc.getSenders().forEach((sender) => {
                if (sender.track && sender.track.kind === "audio" && sender.track.id !== screenStream.current?.getAudioTracks()[0]?.id) {
                  sender.track.enabled = audioTrack.enabled;
                }
              });
            }
          } catch (err) {
            console.warn("Failed to sync mute state to peer:", err);
          }
        });
      }
    }
  };

  const toggleDeafen = () => {
    setIsDeafened((prev) => !prev);
  };

  // Boost the outgoing video sender for a screen-share track:
  // - high maxBitrate (smoother motion in games)
  // - maintain-framerate degradation (drop resolution before FPS)
  // - explicit maxFramerate so the encoder does not cap itself to ~15fps
  const tuneScreenVideoSender = (peer: any, track: MediaStreamTrack) => {
    try {
      const pc: RTCPeerConnection | undefined = peer?._pc;
      if (!pc || typeof pc.getSenders !== "function") return;
      const sender = pc.getSenders().find((s) => s.track === track);
      if (!sender || typeof sender.getParameters !== "function") return;

      const params = sender.getParameters();
      if (!params.encodings || params.encodings.length === 0) {
        params.encodings = [{}];
      }
      params.encodings.forEach((enc: RTCRtpEncodingParameters) => {
        const humanPeerCount = peersRef.current.filter((p) => !isBotPeerId(p.peerID)).length;
        // Mesh upload is duplicated per peer; keep headroom for voice when 3+ users are connected.
        enc.maxBitrate = humanPeerCount >= 2 ? 1_200_000 : 2_500_000;
        (enc as any).maxFramerate = 30;
        (enc as any).networkPriority = "medium";
        (enc as any).priority = "medium";
      });
      (params as any).degradationPreference = "maintain-resolution";

      sender.setParameters(params).catch((err) => {
        console.warn("setParameters (screen video) failed, falling back:", err);
      });
    } catch (err) {
      console.warn("tuneScreenVideoSender skipped:", err);
    }
  };

  const attachActiveScreenTracks = (peerID: string, peer: any) => {
    if (isBotPeerId(peerID)) return;
    if (!screenStream.current || !peer) return;

    const activeTracks = screenStream.current.getTracks().filter((track) => track.readyState === "live");
    if (activeTracks.length === 0) return;

    activeTracks.forEach((track) => {
      try {
        peer.addTrack(track, screenStream.current as MediaStream);
        if (track.kind === "video") {
          // Defer so the sender is fully registered on the RTCPeerConnection
          setTimeout(() => tuneScreenVideoSender(peer, track), 0);
        }
      } catch (err) {
        console.error("Failed to attach active screen track:", err);
      }
    });
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
          echoCancellation: true,   // Keep hardware EC
          noiseSuppression: true,   // CRITICAL: Let browser filter out desktop audio (games/apps)
          autoGainControl: true     // Stabilizes volume over time
        } 
      });

      // 2. Set up Audio Context and Processing
      const audioCtx = new (window.AudioContext || (window as any).webkitAudioContext)({
        sampleRate: 48000,
        latencyHint: 'interactive'
      });
      audioContextRef.current = audioCtx;

      // --------------------------------------------------------
      // Crystal Clear Gamer - Minimalist Audio Chain
      // Fewer nodes = Less CPU = No lag = No robotic sound
      // --------------------------------------------------------

      // A. High-Pass Filter (80Hz) - Removes fan/AC rumble
      const hpFilter = audioCtx.createBiquadFilter();
      hpFilter.type = "highpass";
      hpFilter.frequency.value = 80;

      // B. Pre-Gain - Moderate boost (AGC handles most of it)
      const preGain = audioCtx.createGain();
      preGain.gain.value = 2.0; // +6dB boost

      // C. DeepFilterNet - AI Noise Cancellation
      console.log("[VoiceChat] Initializing DeepFilterNet (Aggressive Noise Canceling - 75%)...");
      const processor = new DeepFilterNet3Processor({
          sampleRate: 48000,
          assetConfig: {
              cdnUrl: '/processors'
          },
          noiseReductionLevel: 75 // AGGRESSIVE: 75/100 to remove game sounds like CS:GO
      });
      await processor.initialize();
      const workletNode = await processor.createAudioWorkletNode(audioCtx);
      deepFilterRef.current = processor;
      processor.setNoiseSuppressionEnabled(noiseSuppressionEnabled);

      // D. Smart Gate - Ultra-sensitive VAD
      const gateNode = audioCtx.createGain();
      const analyser = audioCtx.createAnalyser();
      analyser.fftSize = 256; // Minimum CPU usage
      const bufferLength = analyser.frequencyBinCount;
      const dataArray = new Float32Array(bufferLength);
      
      let lastActiveTime = Date.now();
      let gateOpen = true;
      
      // Get user's preferred threshold from localStorage, default to -42 (moderate)
      const savedThreshold = localStorage.getItem("voiceNoiseThreshold");
      const threshold = savedThreshold ? parseInt(savedThreshold) : -42; // HIGHER THRESHOLD: Stops game audio bleed
      const holdTimeMs = 800; // FAST CLOSE: Closes mic quickly after speaking (0.8s instead of 1.5s)

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
            gateNode.gain.setTargetAtTime(1, audioCtx.currentTime, 0.03); // Fast open
            gateOpen = true;
          }
        } else if (now - lastActiveTime > holdTimeMs) {
          if (gateOpen) {
            gateNode.gain.setTargetAtTime(0, audioCtx.currentTime, 0.6); // Slow fade-out
            gateOpen = false;
          }
        }
      };
      
      // CRITICAL FIX: Use setInterval instead of requestAnimationFrame
      // requestAnimationFrame is heavily throttled (to 1fps or stopped) when the tab is in the background
      // setInterval runs at least once per second in background, keeping the mic gate active
      gateIntervalRef.current = window.setInterval(updateGate, 50) as unknown as number; // Check 20 times per second
      updateGate(); // run once immediately

      // E. Limiter - Safety net for loud sounds
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

      // Connect Graph (MINIMAL):
      // Source -> HPF -> PreGain -> [Analyser] -> DFN -> Gate -> Limiter -> Dest
      console.log("[VoiceChat] Connecting Crystal Clear Gamer Audio Graph (5 nodes only)");
      
      source
        .connect(hpFilter)
        .connect(preGain);
      
      // Sensitivity: Analyser listens BEFORE AI processing
      preGain.connect(analyser);
      
      // Audio path
      preGain
        .connect(workletNode)
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

      socket.on("all-voice-users", (users: VoiceUser[]) => {
        resetRemotePeers();
        const replacePeer = replacePeersOnNextJoinRef.current;
        replacePeersOnNextJoinRef.current = false;
        const peersArr: { peerID: string; peer: any; volume: number; username: string; userId?: number | null }[] = [];
        users.forEach((u) => {
          peerUserDetailsRef.current.set(u.id, u);
          if (socket.id) {
            const peer = createPeer(u.id, socket.id, streamToUse, user.username, user.id, replacePeer);
            peersRef.current.push({ peerID: u.id, peer });
            peersArr.push({ peerID: u.id, peer, volume: 100, username: u.username, userId: u.userId });
          }
        });
        setPeers(peersArr);
      });

      socket.on("user-joined-voice", (payload: { signal: any; callerID: string; username: string; userId?: number | null; replacePeer?: boolean }) => {
        const existing = peersRef.current.find((p) => p.peerID === payload.callerID);
        const isBotPeer = isBotPeerId(payload.callerID);
        const isOfferSignal = payload.signal?.type === "offer";
        peerUserDetailsRef.current.set(payload.callerID, {
          id: payload.callerID,
          username: payload.username,
          userId: payload.userId ?? null
        });
        const shouldReplacePeer = Boolean(
          existing && isOfferSignal && (payload.replacePeer || isBotPeer)
        );

        if (existing && !shouldReplacePeer && isPeerUsable(existing.peer)) {
          existing.peer.signal(payload.signal);
          return;
        }
        if (!isOfferSignal) {
          return;
        }
        if (existing && shouldReplacePeer) {
          try {
            resettingRemotePeersRef.current = true;
            existing.peer.__intentionalDestroy = true;
            existing.peer.destroy();
          } catch {
            // Ignore stale bot peer teardown during seamless replacement.
          } finally {
            resettingRemotePeersRef.current = false;
          }

          clearPeerRecoveryTimers(payload.callerID);
          const peer = addPeer(payload.signal, payload.callerID, streamToUse);
          peersRef.current = peersRef.current.map((p) => (
            p.peerID === payload.callerID ? { peerID: payload.callerID, peer } : p
          ));
          setPeers((prev) => prev.map((p) => (
            p.peerID === payload.callerID
              ? { ...p, peer, username: payload.username || p.username, userId: payload.userId ?? p.userId }
              : p
          )));
          return;
        }
        if (existing) {
          removeRemotePeer(payload.callerID);
        }
        playJoinSound();
        const peer = addPeer(payload.signal, payload.callerID, streamToUse);
        peersRef.current.push({ peerID: payload.callerID, peer });
        setPeers((prev) => [...prev, { peerID: payload.callerID, peer, volume: 100, username: payload.username, userId: payload.userId }]);
      });

      socket.on("receiving-returned-signal", (payload: { signal: any; id: string }) => {
        const item = peersRef.current.find((p) => p.peerID === payload.id);
        if (item) {
          item.peer.signal(payload.signal);
        }
      });

      socket.on("user-left-voice", (id: string) => {
        playLeaveSound();
        peerUserDetailsRef.current.delete(id);
        removeRemotePeer(id);
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

    if (reconnectDebounceTimerRef.current) {
      window.clearTimeout(reconnectDebounceTimerRef.current);
      reconnectDebounceTimerRef.current = null;
    }
    lastReconnectAtRef.current = 0;

    peersRef.current.forEach((p) => {
      try {
        p.peer.__intentionalDestroy = true;
        p.peer.destroy();
      } catch {
        // Ignore peer teardown errors during explicit leave.
      }
    });
    clearAllPeerRecoveryTimers();
    peersRef.current = [];
    setPeers([]);
    setRemoteAudioStreams([]);
    setIncomingStreams([]);
    setHiddenStreams(new Set());
    announcedScreenStreamsRef.current.clear();

    socket?.off("all-voice-users");
    socket?.off("user-joined-voice");
    socket?.off("receiving-returned-signal");
    socket?.off("user-left-voice");
  };

  const attachPeerLifecycle = (peerID: string, peer: any) => {
    clearPeerRecoveryTimers(peerID);
    let recovered = false;

    const isRecoveryOnCooldown = () => {
      const lastRecovery = peerRecoveryCooldownRef.current.get(peerID) || 0;
      return (Date.now() - lastRecovery) < 10000;
    };

    const markRecoveryCooldown = () => {
      peerRecoveryCooldownRef.current.set(peerID, Date.now());
    };

    const recover = (reason: string) => {
      if (recovered || resettingRemotePeersRef.current || peer.__intentionalDestroy) return;
      if (isRecoveryOnCooldown()) {
        console.log(`VoiceChat: Skipping recovery for ${peerID} (cooldown): ${reason}`);
        return;
      }
      recovered = true;
      markRecoveryCooldown();
      if (resettingRemotePeersRef.current) return;
      removeRemotePeer(peerID);
      reconnectRemotePeer(peerID, reason);
    };

    const clearDisconnectGrace = () => {
      const timer = peerDisconnectTimersRef.current.get(peerID);
      if (timer) {
        window.clearTimeout(timer);
        peerDisconnectTimersRef.current.delete(peerID);
      }
    };

    const scheduleDisconnectRecovery = (reason: string) => {
      if (peerDisconnectTimersRef.current.has(peerID)) return;

      const timer = window.setTimeout(() => {
        peerDisconnectTimersRef.current.delete(peerID);
        const pc: RTCPeerConnection | undefined = peer?._pc;
        if (!pc) return;
        if (["connected", "completed"].includes(pc.iceConnectionState) || pc.connectionState === "connected") {
          return;
        }
        recover(reason);
      }, PEER_DISCONNECTED_GRACE_MS);

      peerDisconnectTimersRef.current.set(peerID, timer);
    };

    peer.on("close", () => {
      if (resettingRemotePeersRef.current || peer.__intentionalDestroy) return;
      recover("peer close");
    });
    peer.on("error", (err: any) => {
      console.error("Peer error:", err);
      recover("peer error");
    });

    const pc: RTCPeerConnection | undefined = peer?._pc;
    if (!pc) return;

    const handleConnectionState = () => {
      if (["connected"].includes(pc.connectionState)) {
        clearDisconnectGrace();
      } else if (["failed", "closed"].includes(pc.connectionState)) {
        recover(`peer connection ${pc.connectionState}`);
      } else if (pc.connectionState === "disconnected") {
        scheduleDisconnectRecovery(`peer connection ${pc.connectionState}`);
      }
    };
    const handleIceState = () => {
      if (["connected", "completed"].includes(pc.iceConnectionState)) {
        clearDisconnectGrace();
      } else if (["failed", "closed"].includes(pc.iceConnectionState)) {
        recover(`peer ice ${pc.iceConnectionState}`);
      } else if (pc.iceConnectionState === "disconnected") {
        scheduleDisconnectRecovery(`peer ice ${pc.iceConnectionState}`);
      }
    };

    pc.addEventListener("connectionstatechange", handleConnectionState);
    pc.addEventListener("iceconnectionstatechange", handleIceState);

    const iceTimeout = window.setTimeout(() => {
      if (recovered || resettingRemotePeersRef.current || peer.__intentionalDestroy || peer.destroyed) return;
      const currentState = pc.connectionState || pc.iceConnectionState;
      if (!["connected", "completed"].includes(currentState)) {
        console.warn(`VoiceChat: ICE timeout for ${peerID} (state: ${currentState})`);
        recover("ice candidate timeout");
      }
    }, 30000);
    peerHealthTimersRef.current.set(`${peerID}-ice-timeout`, iceTimeout as unknown as number);

    if (typeof pc.getStats === "function") {
      const healthTimer = window.setInterval(async () => {
        if (recovered || resettingRemotePeersRef.current || peer.__intentionalDestroy || peer.destroyed) return;

        try {
          const currentConnectionState = pc.connectionState;
          const currentIceState = pc.iceConnectionState;
          if (["failed", "closed"].includes(currentConnectionState) || ["failed", "closed"].includes(currentIceState)) {
            recover(`peer health ${currentConnectionState}/${currentIceState}`);
            return;
          }

          const stats = await pc.getStats();
          let bytes = 0;
          let packets = 0;
          let hasInboundAudio = false;

          stats.forEach((report: any) => {
            if (report.type !== "inbound-rtp") return;
            const mediaKind = report.kind || report.mediaType;
            if (mediaKind !== "audio") return;
            hasInboundAudio = true;
            bytes += Number(report.bytesReceived || 0);
            packets += Number(report.packetsReceived || 0);
          });

          if (!hasInboundAudio) return;

          const now = Date.now();
          const previous = peerAudioStatsRef.current.get(peerID);
          if (!previous || bytes > previous.bytes || packets > previous.packets) {
            peerAudioStatsRef.current.set(peerID, { bytes, packets, stalledSince: null });
            return;
          }

          const stalledSince = previous.stalledSince || now;
          peerAudioStatsRef.current.set(peerID, { bytes, packets, stalledSince });
          if (now - stalledSince >= PEER_AUDIO_STALL_MS) {
            recover("peer audio stats stalled");
          }
        } catch (err) {
          console.warn("Peer health check failed:", err);
        }
      }, PEER_LIVENESS_INTERVAL_MS);

      peerHealthTimersRef.current.set(peerID, healthTimer);
    }
  };

  const createPeer = (userToSignal: string, callerID: string, stream: MediaStream, myUsername: string, myUserId: number, replacePeer = false) => {
    const peerStream = stream.clone();
    const originalTrack = stream.getAudioTracks()[0];
    if (originalTrack) {
      peerStream.getAudioTracks().forEach(t => t.enabled = originalTrack.enabled);
    }

    const peer = new PeerClass({
      initiator: true,
      trickle: true,
      stream: peerStream,
      config: {
        iceServers: ICE_SERVERS
      }
    });

    peer.on("signal", (signal: any) => {
      socket?.emit("sending-signal", {
        userToSignal,
        callerID,
        signal,
        username: myUsername,
        userId: myUserId,
        replacePeer: replacePeer && signal?.type === "offer"
      });
    });

    peer.on("stream", (remoteStream: MediaStream) => {
      handleIncomingStream(userToSignal, remoteStream);
    });

    attachPeerLifecycle(userToSignal, peer);
    attachActiveScreenTracks(userToSignal, peer);

    return peer;
  };

  function reconnectRemotePeer(peerID: string, reason: string) {
    if (isBotPeerId(peerID)) {
      rejoinCurrentVoice(reason);
      return;
    }
    if (!socket?.id || !localStream.current || !PeerClass) {
      rejoinCurrentVoice(reason);
      return;
    }
    if (peerReconnectTimersRef.current.has(peerID)) return;

    const timer = window.setTimeout(() => {
      peerReconnectTimersRef.current.delete(peerID);
      if (!socket?.id || !localStream.current || !inVoice) return;
      const existing = peersRef.current.find((p) => p.peerID === peerID);
      if (existing && isPeerUsable(existing.peer)) return;

      const knownUser = peerUserDetailsRef.current.get(peerID);
      const peer = createPeer(
        peerID,
        socket.id,
        localStream.current,
        user.username,
        user.id,
        true
      );

      peersRef.current = [...peersRef.current.filter((p) => p.peerID !== peerID), { peerID, peer }];
      setPeers((prev) => {
        const previous = prev.find((p) => p.peerID === peerID);
        return [
          ...prev.filter((p) => p.peerID !== peerID),
          {
            peerID,
            peer,
            volume: previous?.volume ?? 100,
            username: knownUser?.username || previous?.username || `User ${peerID.substring(0, 4)}`,
            userId: knownUser?.userId ?? previous?.userId
          }
        ];
      });
    }, 500);

    peerReconnectTimersRef.current.set(peerID, timer);
  }

  const addPeer = (incomingSignal: any, callerID: string, stream: MediaStream) => {
    const peerStream = stream.clone();
    const originalTrack = stream.getAudioTracks()[0];
    if (originalTrack) {
      peerStream.getAudioTracks().forEach(t => t.enabled = originalTrack.enabled);
    }

    const peer = new PeerClass({
      initiator: false,
      trickle: true,
      stream: peerStream,
      config: {
        iceServers: ICE_SERVERS
      }
    });

    peer.on("signal", (signal: any) => {
      socket?.emit("returning-signal", { signal, callerID });
    });

    peer.on("stream", (remoteStream: MediaStream) => {
      handleIncomingStream(callerID, remoteStream);
    });

    attachPeerLifecycle(callerID, peer);
    attachActiveScreenTracks(callerID, peer);

    peer.signal(incomingSignal);

    return peer;
  };

  const handleIncomingStream = (id: string, stream: MediaStream) => {
    const audioTracks = stream.getAudioTracks();
    const videoTracks = stream.getVideoTracks();

    if (audioTracks.length > 0 && videoTracks.length === 0) {
      const audioStream = new MediaStream(audioTracks);
      setRemoteAudioStreams((prev) => {
        const existing = prev.find((s) => s.id === id);
        if (existing?.stream.id === audioStream.id) return prev;
        return [...prev.filter((s) => s.id !== id), { id, stream: audioStream }];
      });
    }

    if (videoTracks.length > 0) {
      const streamKey = `${id}-${stream.id}`;
      if (!announcedScreenStreamsRef.current.has(streamKey)) {
        announcedScreenStreamsRef.current.add(streamKey);
        playScreenStartSound();
      }

      setIncomingStreams((prev) => {
        if (prev.find((s) => s.id === id && s.stream.id === stream.id)) return prev;
        return [...prev, { id, stream }];
      });
    }
  };

  const startScreenShare = () => {
    if (!PeerClass || !localStream.current) return;
    
    // High quality defaults for smooth gameplay viewing.
    // Ideal 1080p60; tarayici destegi yoksa otomatik olarak dusurur (stabilite).
    const constraints: MediaStreamConstraints = {
      video: {
        // 1080p30 varsayilan — oyun akiciligi icin yeterli, Turkiye ev uplink'i
        // ve 3+ peer mesh icin surdurulebilir. Kullanici browser'i daha
        // dusuk destekliyorsa otomatik dusurur.
        width: { ideal: 1920, max: 1920 },
        height: { ideal: 1080, max: 1080 },
        frameRate: { ideal: 30, max: 60 },
      } as MediaTrackConstraints,
      audio: {
        echoCancellation: false,
        noiseSuppression: false,
        autoGainControl: false,
        // @ts-ignore — chrome-specific hints for higher fidelity screen audio
        sampleRate: 48000,
        channelCount: 2,
      } as MediaTrackConstraints
    };

    navigator.mediaDevices
      .getDisplayMedia(constraints)
      .then((stream: MediaStream) => {
        setIsSharingScreen(true);
        screenStream.current = stream;

        const videoTrack = stream.getVideoTracks()[0];
        const screenAudioTrack = stream.getAudioTracks()[0];

        // Content hints: encoder'a hareketli icerik (oyun) ipucu ver -> daha akici FPS.
        if (videoTrack && "contentHint" in videoTrack) {
          try { (videoTrack as any).contentHint = "motion"; } catch {}
        }
        if (screenAudioTrack && "contentHint" in screenAudioTrack) {
          try { (screenAudioTrack as any).contentHint = "music"; } catch {}
        }

        // Create a combined stream with video + screen audio for VideoPlayer volume control
        // Microphone stays separate in AudioPlayer
        if (screenAudioTrack && videoTrack) {
          // Create a new stream with both video and screen audio
          const screenShareStream = new MediaStream([videoTrack, screenAudioTrack]);

          peersRef.current.forEach((p) => {
            if (isBotPeerId(p.peerID)) return;
            // Add video track
            p.peer.addTrack(videoTrack, screenShareStream);
            // Add screen audio track separately (will create new stream on receiver)
            p.peer.addTrack(screenAudioTrack, screenShareStream);
            // Bitrate / framerate tuning for the freshly added video sender
            setTimeout(() => tuneScreenVideoSender(p.peer, videoTrack), 0);
          });

          console.log("Screen share started with screen audio (separate from mic)");
        } else if (videoTrack) {
          // No screen audio - just add video
          peersRef.current.forEach((p) => {
            if (isBotPeerId(p.peerID)) return;
            p.peer.addTrack(videoTrack, stream);
            setTimeout(() => tuneScreenVideoSender(p.peer, videoTrack), 0);
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
      if (isBotPeerId(p.peerID)) return;
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
                    <span className="flex flex-1 items-center gap-1.5 truncate">
                      <span className="truncate">{user.username}</span>
                      {roomCreatorId === user.id && <CrownIcon className="text-amber-300" />}
                    </span>
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
                    const peerUserId = typeof p.userId === "number" ? p.userId : null;
                    const canKickPeer = roomCreatorId === user.id && !!peerUserId && peerUserId !== user.id;
                    
                    return (
                      <div key={p.peerID} className="flex items-center gap-2 text-xs py-0.5 px-1 rounded text-zinc-400">
                        <div className="w-5 h-5 rounded-full bg-gradient-to-br from-emerald-500 to-teal-600 flex items-center justify-center text-[10px] font-bold text-white">
                          {(p.username || "?")[0].toUpperCase()}
                        </div>
                        <button
                          type="button"
                          disabled={!canKickPeer}
                          onClick={() => canKickPeer && onKickUser?.({ id: peerUserId ?? 0, username: p.username || `User ${p.peerID.substring(0, 4)}` })}
                          className={`flex flex-1 items-center gap-1.5 truncate text-left ${canKickPeer ? "hover:text-red-300" : "cursor-default"}`}
                          title={canKickPeer ? "Kullaniciyi odadan at" : undefined}
                        >
                          <span className="truncate">{p.username || `User ${p.peerID.substring(0, 4)}`}</span>
                          {peerUserId === roomCreatorId && <CrownIcon className="text-amber-300" />}
                        </button>
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
                      <button
                        type="button"
                        disabled={!(roomCreatorId === user.id && typeof u.userId === "number" && u.userId !== user.id)}
                        onClick={() => typeof u.userId === "number" && onKickUser?.({ id: u.userId, username: u.username })}
                        className={`flex flex-1 items-center gap-1.5 truncate text-left ${roomCreatorId === user.id && typeof u.userId === "number" && u.userId !== user.id ? "hover:text-red-300" : "cursor-default"}`}
                        title={roomCreatorId === user.id && typeof u.userId === "number" && u.userId !== user.id ? "Kullaniciyi odadan at" : undefined}
                      >
                        <span className="truncate">{u.username}</span>
                        {u.userId === roomCreatorId && <CrownIcon className="text-amber-300" />}
                      </button>
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
                    max="200"
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
          audioStream={remoteAudioStreams.find((s) => s.id === p.peerID)?.stream || null}
          volume={isDeafened ? 0 : p.volume / 100}
          onStalled={(reason) => {
            removeRemotePeer(p.peerID);
            rejoinCurrentVoice(reason);
          }}
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

const AudioPlayer = ({ audioStream, volume = 1, onStalled }: { audioStream: MediaStream | null; volume?: number; onStalled?: (reason: string) => void }) => {
  const audioRef = useRef<HTMLAudioElement>(null);
  const audioContextRef = useRef<AudioContext | null>(null);
  const mediaSourceRef = useRef<MediaElementAudioSourceNode | null>(null);
  const gainRef = useRef<GainNode | null>(null);
  const limiterRef = useRef<DynamicsCompressorNode | null>(null);
  const volumeRef = useRef(volume);
  const onStalledRef = useRef(onStalled);
  const webAudioDisabledRef = useRef(false);

  useEffect(() => {
    onStalledRef.current = onStalled;
  }, [onStalled]);

  const teardownAudioGraph = () => {
    mediaSourceRef.current?.disconnect();
    gainRef.current?.disconnect();
    limiterRef.current?.disconnect();
    mediaSourceRef.current = null;
    gainRef.current = null;
    limiterRef.current = null;

    if (audioContextRef.current) {
      void audioContextRef.current.close().catch(() => {});
      audioContextRef.current = null;
    }
  };

  const ensureAudioGraph = () => {
    if (typeof window === "undefined" || webAudioDisabledRef.current) {
      return false;
    }

    if (audioContextRef.current && gainRef.current) {
      return true;
    }

    const audioEl = audioRef.current;
    if (!audioEl) {
      return false;
    }

    const AudioContextCtor = window.AudioContext || (window as Window & typeof globalThis & { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!AudioContextCtor) {
      webAudioDisabledRef.current = true;
      return false;
    }

    try {
      const ctx = new AudioContextCtor({ latencyHint: "interactive" });
      const source = ctx.createMediaElementSource(audioEl);
      const gain = ctx.createGain();
      const limiter = ctx.createDynamicsCompressor();

      limiter.threshold.setValueAtTime(-5, ctx.currentTime);
      limiter.knee.setValueAtTime(6, ctx.currentTime);
      limiter.ratio.setValueAtTime(12, ctx.currentTime);
      limiter.attack.setValueAtTime(0.003, ctx.currentTime);
      limiter.release.setValueAtTime(0.12, ctx.currentTime);

      source.connect(gain).connect(limiter).connect(ctx.destination);

      audioContextRef.current = ctx;
      mediaSourceRef.current = source;
      gainRef.current = gain;
      limiterRef.current = limiter;
      return true;
    } catch (error) {
      console.error("[VoiceChat] Web Audio playback chain failed, using direct audio fallback:", error);
      webAudioDisabledRef.current = true;
      teardownAudioGraph();
      return false;
    }
  };

  useEffect(() => {
    volumeRef.current = volume;
    const nextGain = Math.max(0, Math.min(2, volume));

    if (gainRef.current && audioContextRef.current) {
      gainRef.current.gain.setTargetAtTime(nextGain, audioContextRef.current.currentTime, 0.02);
      audioContextRef.current.resume().catch(() => {});
    }

    // Always mirror onto the audio element as well.
    // Chrome has a known bug where <audio srcObject=MediaStream> + createMediaElementSource
    // leaves the element's audio output bypassing the Web Audio graph, so gain alone
    // does not affect volume. Setting audioEl.volume guarantees the slider works.
    if (audioRef.current) {
      audioRef.current.volume = Math.max(0, Math.min(1, nextGain));
    }
  }, [volume]);

  useEffect(() => {
    return () => {
      teardownAudioGraph();
    };
  }, []);

  useEffect(() => {
    const audioEl = audioRef.current;

    if (!audioEl) {
      return;
    }

    if (!audioStream) {
      audioEl.pause();
      audioEl.srcObject = null;
      return;
    }

    audioEl.srcObject = audioStream;
    audioEl.muted = false;
    const nextGain = Math.max(0, Math.min(2, volumeRef.current));

    if (ensureAudioGraph() && gainRef.current && audioContextRef.current) {
      gainRef.current.gain.setValueAtTime(nextGain, audioContextRef.current.currentTime);
      audioContextRef.current.resume().catch(() => {});
    }
    // Always set element volume too; Web Audio graph may be bypassed on some browsers
    // when using srcObject + createMediaElementSource, so element volume is authoritative.
    audioEl.volume = Math.max(0, Math.min(1, nextGain));

    const resumePlayback = () => {
      if (audioContextRef.current?.state === "suspended") {
        audioContextRef.current.resume().catch(() => {});
      }
      audioEl.play().catch(() => {});
    };

    const resumeWhenVisible = () => {
      if (document.visibilityState !== "hidden") {
        resumePlayback();
      }
    };

    const handleEnded = () => {
      onStalledRef.current?.("remote audio ended");
    };

    const handleTrackEnded = () => {
      onStalledRef.current?.("remote audio track ended");
    };

    const audioTracks = audioStream.getAudioTracks();
    audioTracks.forEach((track) => {
      track.addEventListener("mute", resumePlayback);
      track.addEventListener("unmute", resumePlayback);
      track.addEventListener("ended", handleTrackEnded);
    });

    audioEl.addEventListener("pause", resumePlayback);
    audioEl.addEventListener("stalled", resumePlayback);
    audioEl.addEventListener("waiting", resumePlayback);
    audioEl.addEventListener("suspend", resumeWhenVisible);
    audioEl.addEventListener("ended", handleEnded);
    window.addEventListener("focus", resumePlayback);
    window.addEventListener("pageshow", resumePlayback);
    document.addEventListener("visibilitychange", resumeWhenVisible);

    resumePlayback();
    const playbackWatchdog = window.setInterval(resumePlayback, AUDIO_PLAYBACK_RESUME_INTERVAL_MS);

    return () => {
      window.clearInterval(playbackWatchdog);
      audioTracks.forEach((track) => {
        track.removeEventListener("mute", resumePlayback);
        track.removeEventListener("unmute", resumePlayback);
        track.removeEventListener("ended", handleTrackEnded);
      });
      audioEl.removeEventListener("pause", resumePlayback);
      audioEl.removeEventListener("stalled", resumePlayback);
      audioEl.removeEventListener("waiting", resumePlayback);
      audioEl.removeEventListener("suspend", resumeWhenVisible);
      audioEl.removeEventListener("ended", handleEnded);
      window.removeEventListener("focus", resumePlayback);
      window.removeEventListener("pageshow", resumePlayback);
      document.removeEventListener("visibilitychange", resumeWhenVisible);
      audioEl.pause();
      audioEl.srcObject = null;
    };
  }, [audioStream]);

  return (
    <div style={{ position: "absolute", top: 0, left: 0, width: 0, height: 0, overflow: "hidden", visibility: "hidden" }}>
      <audio ref={audioRef} autoPlay playsInline controls={false} />
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
        <div className="absolute bottom-2 left-2 right-2 bg-black/80 backdrop-blur-md px-3 py-2.5 rounded-xl flex items-center gap-3 z-20 border border-white/10 shadow-lg animate-in fade-in slide-in-from-bottom-2">
          <div className="flex items-center gap-2">
            <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="text-indigo-400 flex-shrink-0">
              <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/>
              <path d="M15.54 8.46a5 5 0 0 1 0 7.07"/>
            </svg>
            <span className="text-[10px] font-bold text-zinc-400 uppercase tracking-tighter">Stream</span>
          </div>
          <input
            type="range"
            min="0"
            max="150"
            step="1"
            value={volume}
            onChange={(e) => setVolume(parseInt(e.target.value))}
            className="flex-1 h-1.5 bg-zinc-700 rounded-lg appearance-none cursor-pointer accent-indigo-500"
            onClick={(e) => e.stopPropagation()}
            onMouseDown={(e) => e.stopPropagation()}
          />
          <span className={`text-[11px] font-mono w-10 text-right ${volume > 100 ? "text-orange-400 font-bold" : "text-zinc-300"}`}>
            {volume}%
          </span>
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
