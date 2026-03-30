"use client";

import { useEffect, useState, useRef, Suspense, useCallback, useMemo } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import io, { Socket } from "socket.io-client";
import dynamic from "next/dynamic";

const VoiceChat = dynamic(() => import("@/components/VoiceChat"), {
  ssr: false,
  loading: () => (
    <div className="flex-1 flex items-center justify-center">
      <div className="text-xs text-zinc-500">Loading Voice Module...</div>
    </div>
  ),
});

interface Message {
  id: number;
  content: string;
  username: string;
  user_id: number;
  created_at: string;
  type: "text" | "file" | "command";
  fileUrl?: string;
  fileName?: string;
  room_id?: string;
}

interface MusicTrack {
  id: string;
  title: string;
  durationInSec: number;
  thumbnail?: string | null;
  requestedBy?: string | null;
  prefetchStatus?: string;
}

interface MusicState {
  roomId: string;
  voiceRoomId: string | null;
  isPlaying: boolean;
  isPaused: boolean;
  volume: number;
  positionSec: number;
  current: MusicTrack | null;
  queue: MusicTrack[];
}

const formatClock = (seconds: number) => {
  const safe = Math.max(0, Math.floor(seconds || 0));
  const mins = Math.floor(safe / 60);
  const secs = safe % 60;
  return `${mins}:${secs.toString().padStart(2, "0")}`;
};

const formatPrefetchStatus = (status?: string) => {
  switch ((status || "").toLowerCase()) {
    case "prefetching":
      return "Indiriliyor";
    case "prefetched":
      return "Hazir";
    case "playing":
      return "Caliyor";
    case "failed":
      return "Indirme hatasi";
    default:
      return "Kuyrukta";
  }
};

const SLASH_COMMANDS = [
  { command: "/play", usage: "/play <yt-link veya sarki adi>", description: "Sarkiyi cal veya kuyruga ekle" },
  { command: "/search", usage: "/search <sarki adi>", description: "Ilk sonuc adaylarini listele" },
  { command: "/queue", usage: "/queue", description: "Siradaki parcayi goster" },
  { command: "/skip", usage: "/skip", description: "Calan parcayi atla" },
  { command: "/pause", usage: "/pause", description: "Muzigi duraklat" },
  { command: "/resume", usage: "/resume", description: "Muzigi devam ettir" },
  { command: "/stop", usage: "/stop", description: "Botu durdur ve kapat" },
  { command: "/np", usage: "/np", description: "Simdi calani goster" },
  { command: "/volume", usage: "/volume <0-200>", description: "Ses seviyesini ayarla" },
  { command: "/help", usage: "/help", description: "Tum muzik komutlarini goster" }
];

function ChatContent() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const roomId = searchParams.get("roomId");

  const [user, setUser] = useState<{ id: number; username: string } | null>(null);
  const [socket, setSocket] = useState<Socket | null>(null);
  const [isConnected, setIsConnected] = useState(false);
  const [messages, setMessages] = useState<Message[]>([]);
  const [inputValue, setInputValue] = useState("");
  const [isUploading, setIsUploading] = useState(false);
  const [pastePreview, setPastePreview] = useState<string | null>(null);
  const [pasteFile, setPasteFile] = useState<File | null>(null);
  const [showSettings, setShowSettings] = useState(false);
  const [newUsername, setNewUsername] = useState("");
  const [usernameError, setUsernameError] = useState("");
  const [isUpdatingUsername, setIsUpdatingUsername] = useState(false);
  const [copiedMessageId, setCopiedMessageId] = useState<number | null>(null);
  const [activeCommandIndex, setActiveCommandIndex] = useState(0);
  const [musicState, setMusicState] = useState<MusicState | null>(null);
  const [musicControlError, setMusicControlError] = useState("");
  const [seekDragValue, setSeekDragValue] = useState<number | null>(null);
  
  // Voice Settings State
  const [noiseThreshold, setNoiseThreshold] = useState(-42); // Default -42 dB

  const messagesEndRef = useRef<HTMLDivElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const copyFeedbackTimeoutRef = useRef<number | null>(null);

  const filteredCommands = useMemo(() => {
    const trimmed = inputValue.trimStart();
    if (!trimmed.startsWith("/")) return [];

    const [commandPart] = trimmed.split(/\s+/, 1);
    const query = commandPart.toLowerCase();

    return SLASH_COMMANDS.filter((item) => item.command.startsWith(query)).slice(0, 6);
  }, [inputValue]);

  const showCommandSuggestions = filteredCommands.length > 0 && inputValue.trimStart().startsWith("/");

  useEffect(() => {
    if (!showCommandSuggestions) {
      setActiveCommandIndex(0);
      return;
    }

    setActiveCommandIndex((prev) => Math.min(prev, filteredCommands.length - 1));
  }, [filteredCommands.length, showCommandSuggestions]);

  const scrollToBottom = () => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  };

  useEffect(() => {
    scrollToBottom();
  }, [messages]);

  useEffect(() => {
    return () => {
      if (copyFeedbackTimeoutRef.current !== null) {
        window.clearTimeout(copyFeedbackTimeoutRef.current);
      }
    };
  }, []);

  // Ctrl+V paste handler for screenshots
  useEffect(() => {
    const handlePaste = (e: ClipboardEvent) => {
      const items = e.clipboardData?.items;
      if (!items) return;

      for (let i = 0; i < items.length; i++) {
        if (items[i].type.indexOf("image") !== -1) {
          const file = items[i].getAsFile();
          if (file) {
            e.preventDefault();
            const previewUrl = URL.createObjectURL(file);
            setPastePreview(previewUrl);
            setPasteFile(file);
          }
          break;
        }
      }
    };

    window.addEventListener("paste", handlePaste);
    return () => window.removeEventListener("paste", handlePaste);
  }, []);

  const uploadPastedImage = async () => {
    if (!pasteFile || !socket || !user || !roomId) return;

    setIsUploading(true);
    const formData = new FormData();
    const filename = `screenshot_${Date.now()}.png`;
    formData.append("file", pasteFile, filename);

    const API_URL = process.env.NEXT_PUBLIC_API_URL || "http://localhost:3001";

    try {
      const res = await fetch(`${API_URL}/api/upload`, {
        method: "POST",
        body: formData,
      });
      const data = await res.json();

      if (data.success) {
        const fullUrl = `${API_URL}${data.url}`;

        socket.emit("send-message", {
          content: fullUrl,
          user: user,
          type: "file",
          fileUrl: fullUrl,
          fileName: data.filename,
          roomId,
        });
      }
    } catch (err) {
      console.error("Upload failed", err);
      alert("Upload failed");
    } finally {
      setIsUploading(false);
      cancelPaste();
    }
  };

  const cancelPaste = () => {
    if (pastePreview) {
      URL.revokeObjectURL(pastePreview);
    }
    setPastePreview(null);
    setPasteFile(null);
  };

  const deleteMessage = async (messageId: number) => {
    if (!user) return;
    
    const API_URL = process.env.NEXT_PUBLIC_API_URL || "http://localhost:3001";
    
    try {
      const res = await fetch(`${API_URL}/api/messages/${messageId}`, {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ userId: user.id }),
      });
      
      if (!res.ok) {
        const data = await res.json();
        alert(data.error || "Mesaj silinemedi");
      }
    } catch (err) {
      console.error("Delete failed", err);
      alert("Mesaj silinemedi");
    }
  };

  const copyMessageContent = async (message: Message) => {
    const textToCopy = message.type === "file" ? message.fileUrl || message.content : message.content;

    if (!textToCopy) return;

    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(textToCopy);
      } else {
        const textarea = document.createElement("textarea");
        textarea.value = textToCopy;
        textarea.style.position = "fixed";
        textarea.style.opacity = "0";
        document.body.appendChild(textarea);
        textarea.focus();
        textarea.select();
        document.execCommand("copy");
        document.body.removeChild(textarea);
      }

      setCopiedMessageId(message.id);
      if (copyFeedbackTimeoutRef.current !== null) {
        window.clearTimeout(copyFeedbackTimeoutRef.current);
      }
      copyFeedbackTimeoutRef.current = window.setTimeout(() => {
        setCopiedMessageId(null);
      }, 1400);
    } catch (err) {
      console.error("Copy failed:", err);
      alert("Mesaj kopyalanamadi");
    }
  };

  useEffect(() => {
    const token = localStorage.getItem("token");
    const storedUser = localStorage.getItem("user");

    // Load preferred noise threshold on mount
    const savedThreshold = localStorage.getItem("voiceNoiseThreshold");
    if (savedThreshold) {
      setNoiseThreshold(parseInt(savedThreshold));
    }

    if (!token || !storedUser) {
      router.push("/login");
      return;
    }

    if (!roomId) {
      router.push("/rooms");
      return;
    }

    const parsedUser = JSON.parse(storedUser);
    setUser(parsedUser);

    const API_URL = process.env.NEXT_PUBLIC_API_URL || "http://localhost:3001";

    // Fetch messages for this room
    fetch(`${API_URL}/api/messages?roomId=${roomId}`)
      .then((res) => res.json())
      .then((data) => {
        if (Array.isArray(data)) {
          setMessages(data);
        } else {
          setMessages([]);
        }
      })
      .catch((err) => {
        console.error("Failed to load history", err);
        setMessages([]);
      });

    const newSocket = io(API_URL);
    setSocket(newSocket);

    newSocket.on("connect", () => {
      console.log("Connected to socket server");
      setIsConnected(true);
      // Join specific text room with username for tracking
      newSocket.emit("join-room", { roomId, username: parsedUser.username });
      // CRITICAL: Send immediate heartbeat to establish session in database
      newSocket.emit("heartbeat", { roomId });
    });

    // Handle reconnection - re-join room after reconnect
    newSocket.on("reconnect", () => {
      console.log("Reconnected to socket server");
      setIsConnected(true);
      newSocket.emit("join-room", { roomId, username: parsedUser.username });
      // CRITICAL: Send immediate heartbeat on reconnect
      newSocket.emit("heartbeat", { roomId });
    });

    // CRITICAL: Heartbeat to keep session alive in database
    // Sends every 30 seconds to prevent stale session cleanup
    const heartbeatInterval = setInterval(() => {
      if (newSocket.connected) {
        newSocket.emit("heartbeat", { roomId });
      }
    }, 30000);

    newSocket.on("disconnect", () => {
      console.log("Disconnected from socket server");
      setIsConnected(false);
    });

    newSocket.on("connect_error", (error) => {
      console.error("Socket connection error:", error);
      setIsConnected(false);
    });

    newSocket.on("message-received", (message: Message) => {
      // Only add if it belongs to this room (socket.io broadcast filtering is safer but this is double check)
      if (message && message.id && message.room_id === roomId) {
        setMessages((prev) => [...prev, message]);

        // Başkasından gelen mesajlarda ses çal (kendi mesajımda çift ses olmasın)
        if (message.user_id !== parsedUser.id) {
          if (typeof window !== "undefined") {
            try {
              const ctx = new AudioContext();
              const osc = ctx.createOscillator();
              const gain = ctx.createGain();
              osc.connect(gain);
              gain.connect(ctx.destination);
              osc.type = "sine";
              osc.frequency.setValueAtTime(880, ctx.currentTime);
              osc.frequency.exponentialRampToValueAtTime(660, ctx.currentTime + 0.08);
              gain.gain.setValueAtTime(0.08, ctx.currentTime);
              gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.12);
              osc.start(ctx.currentTime);
              osc.stop(ctx.currentTime + 0.12);
              osc.onended = () => ctx.close();
            } catch {}
          }
        }
      }
    });

    newSocket.on("message-deleted", (data: { id: number; roomId?: string }) => {
      if (data.roomId && data.roomId !== roomId) return;
      setMessages((prev) => prev.filter((m) => m.id !== data.id));
    });
    
    newSocket.on("message-error", (data: { error: string }) => {
      console.error("Message error from server:", data.error);
      alert(`Mesaj gönderilemedi: ${data.error}`);
    });

    newSocket.on("music-state", (state: MusicState) => {
      if (!state || state.roomId !== roomId) return;
      setMusicState(state);
    });

    newSocket.on("music-control-error", (data: { error: string }) => {
      const message = data?.error || "Muzik kontrolu basarisiz.";
      setMusicControlError(message);
      window.setTimeout(() => {
        setMusicControlError((prev) => (prev === message ? "" : prev));
      }, 2500);
    });

    return () => {
      clearInterval(heartbeatInterval);
      setIsConnected(false);
      setMusicState(null);
      newSocket.disconnect();
    };
  }, [router, roomId]);

  const handleSendMessage = (e: React.FormEvent) => {
    e.preventDefault();
    if (!inputValue.trim()) return;
    
    if (!socket || !socket.connected) {
      console.error("Cannot send message: socket not connected");
      alert("Bağlantı kesildi, lütfen sayfayı yenileyin.");
      return;
    }
    
    if (!user || !user.id || !user.username) {
      console.error("Cannot send message: user not set properly", user);
      alert("Kullanıcı bilgisi bulunamadı, lütfen tekrar giriş yapın.");
      return;
    }
    
    if (!roomId) {
      console.error("Cannot send message: roomId not set");
      return;
    }

    // Ensure user.id is a number
    const messageUser = {
      id: Number(user.id),
      username: user.username
    };

    console.log("Sending message:", { content: inputValue, user: messageUser, roomId });
    socket.emit("send-message", {
      content: inputValue,
      user: messageUser,
      type: "text",
      roomId,
    });

    // Mesaj gönderme sesi (Web Audio API)
    if (typeof window !== "undefined") {
      try {
        const ctx = new AudioContext();
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.connect(gain);
        gain.connect(ctx.destination);
        osc.type = "sine";
        osc.frequency.setValueAtTime(880, ctx.currentTime);
        osc.frequency.exponentialRampToValueAtTime(660, ctx.currentTime + 0.08);
        gain.gain.setValueAtTime(0.08, ctx.currentTime);
        gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.12);
        osc.start(ctx.currentTime);
        osc.stop(ctx.currentTime + 0.12);
        osc.onended = () => ctx.close();
      } catch {}
    }

    setInputValue("");
  };

  const applyCommandSuggestion = (index: number) => {
    const selected = filteredCommands[index];
    if (!selected) return;

    const nextValue = selected.usage.includes("<") ? `${selected.usage} ` : selected.command;
    setInputValue(nextValue);
    setActiveCommandIndex(index);
  };

  const handleFileUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file || !socket || !user || !roomId) return;

    setIsUploading(true);
    const formData = new FormData();
    formData.append("file", file);

    const API_URL = process.env.NEXT_PUBLIC_API_URL || "http://localhost:3001";

    try {
      const res = await fetch(`${API_URL}/api/upload`, {
        method: "POST",
        body: formData,
      });
      const data = await res.json();

      if (data.success) {
        const fullUrl = `${API_URL}${data.url}`;

        socket.emit("send-message", {
          content: fullUrl,
          user: user,
          type: "file",
          fileUrl: fullUrl,
          fileName: data.filename,
          roomId,
        });
      }
    } catch (err) {
      console.error("Upload failed", err);
      alert("Upload failed");
    } finally {
      setIsUploading(false);
      if (fileInputRef.current) fileInputRef.current.value = "";
    }
  };

  const updateUsername = async () => {
    if (!user || !newUsername.trim()) return;
    
    if (newUsername.trim().length < 2) {
      setUsernameError("En az 2 karakter olmali");
      return;
    }
    
    if (newUsername.length > 20) {
      setUsernameError("En fazla 20 karakter olmali");
      return;
    }
    
    setIsUpdatingUsername(true);
    setUsernameError("");
    
    const API_URL = process.env.NEXT_PUBLIC_API_URL || "http://localhost:3001";
    
    try {
      const res = await fetch(`${API_URL}/api/users/${user.id}/username`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username: newUsername.trim() }),
      });
      
      const data = await res.json();
      
      if (res.ok && data.success) {
        const updatedUser = { ...user, username: data.username };
        setUser(updatedUser);
        localStorage.setItem("user", JSON.stringify(updatedUser));
        setShowSettings(false);
        setNewUsername("");
      } else {
        setUsernameError(data.error || "Guncelleme basarisiz");
      }
    } catch (err) {
      console.error("Username update failed:", err);
      setUsernameError("Baglanti hatasi");
    } finally {
      setIsUpdatingUsername(false);
    }
  };

  const saveNoiseThreshold = (value: number) => {
    setNoiseThreshold(value);
    localStorage.setItem("voiceNoiseThreshold", value.toString());
  };

  const sendMusicControl = useCallback((action: string, value?: number) => {
    if (!socket || !roomId) return;
    socket.emit("music-control", { roomId, action, value });
  }, [socket, roomId]);

  const canRenderMusicPlayer = !!musicState?.current || (musicState?.queue?.length || 0) > 0;
  const currentDuration = Number(musicState?.current?.durationInSec || 0);
  const effectiveSeekValue = seekDragValue ?? Number(musicState?.positionSec || 0);
  const currentPrefetchStatus = formatPrefetchStatus(musicState?.current?.prefetchStatus);
  const canControlCurrent = !!musicState?.current;
  const canSeekCurrent = canControlCurrent && currentDuration > 0;

  if (!user || !roomId) return null;

  // Extract display name from roomId (simple heuristic)
  const roomDisplayName = roomId.split('-')[0].toUpperCase();

  return (
    <div className="flex h-screen bg-zinc-950 text-zinc-100 font-sans">
      {/* Sidebar */}
      <div className="hidden md:flex w-72 bg-zinc-900 border-r border-zinc-800 flex-col">
        {/* Header */}
        <div className="p-4 border-b border-zinc-800 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 bg-gradient-to-br from-indigo-600 to-purple-600 rounded-xl flex items-center justify-center shadow-lg shadow-indigo-500/20">
              <span className="font-bold text-white text-lg">{roomDisplayName[0]}</span>
            </div>
            <div>
              <h1 className="font-bold text-sm tracking-tight text-white truncate max-w-[120px]">{roomDisplayName}</h1>
              <p className="text-[10px] text-zinc-500">Server</p>
            </div>
          </div>
          <button 
            onClick={() => router.push('/rooms')}
            className="text-zinc-500 hover:text-white p-1 rounded-md hover:bg-zinc-800 transition-colors"
            title="Switch Server"
          >
            <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><polyline points="16 17 21 12 16 7"/><line x1="21" x2="9" y1="12" y2="12"/></svg>
          </button>
        </div>

        {/* Channels */}
        <div className="p-3 space-y-4">
          <div>
            <div className="px-2 py-1.5 flex items-center justify-between text-zinc-500">
              <span className="text-xs font-bold uppercase tracking-wider">Text Channels</span>
            </div>
            <div className="space-y-0.5 mt-1">
              <div className="flex items-center gap-2 px-2 py-1.5 bg-zinc-800 rounded-md text-white cursor-default">
                <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="text-zinc-400"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>
                <span className="text-sm font-medium">general</span>
              </div>
            </div>
          </div>
        </div>

        {/* Voice Channels Area */}
        <div className="flex-1 flex flex-col p-3 pt-0 overflow-hidden">
           {/* VoiceChat now handles connection to this specific roomId */}
          <VoiceChat socket={socket} roomId={roomId} user={user} />
        </div>

        {/* User Panel */}
        <div className="p-3 bg-zinc-900 border-t border-zinc-800">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <div className="relative">
                <div className="w-9 h-9 rounded-full bg-gradient-to-br from-indigo-500 to-purple-600 flex items-center justify-center font-bold text-white shadow-lg">
                  {user.username[0].toUpperCase()}
                </div>
                <div className={`absolute -bottom-0.5 -right-0.5 w-3.5 h-3.5 rounded-full border-2 border-zinc-900 ${isConnected ? "bg-green-500" : "bg-yellow-500 animate-pulse"}`}></div>
              </div>
              <div>
                <div className="text-sm font-medium text-white">{user.username}</div>
                <div className={`text-xs ${isConnected ? "text-green-400" : "text-yellow-400"}`}>
                  {isConnected ? "Online" : "Baglaniyor..."}
                </div>
              </div>
            </div>
            <button
              onClick={() => {
                setNewUsername(user.username);
                setUsernameError("");
                setShowSettings(true);
              }}
              className="p-2 text-zinc-500 hover:text-white hover:bg-zinc-800 rounded-lg transition-colors"
              title="Ayarlar"
            >
              <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <circle cx="12" cy="12" r="3"/><path d="M12 1v6m0 6v6m8.66-9h-6m-6 0H2.34"/>
              </svg>
            </button>
          </div>
        </div>
      </div>

      {/* Main Chat Area */}
      <div className="flex-1 flex flex-col min-w-0 bg-zinc-950">
        <div className="h-16 border-b border-zinc-800 flex items-center px-6 bg-zinc-900/50 backdrop-blur-sm sticky top-0 z-10">
          <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="text-zinc-500 mr-2"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>
          <span className="font-bold text-white">general</span>
          <span className="mx-2 text-zinc-700">|</span>
          <span className="text-xs text-zinc-500">Welcome to {roomDisplayName} server!</span>
        </div>

        <div className="flex-1 p-6 overflow-y-auto space-y-4">
          {messages.length === 0 && (
            <div className="flex flex-col items-center justify-center h-full text-center opacity-50">
              <div className="w-16 h-16 bg-zinc-800 rounded-full flex items-center justify-center mb-4">
                <svg xmlns="http://www.w3.org/2000/svg" width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" className="text-zinc-500"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>
              </div>
              <h3 className="text-lg font-semibold text-zinc-300">Welcome to #general!</h3>
              <p className="text-sm text-zinc-500 mt-1">This is the start of the conversation.</p>
            </div>
          )}

          {messages.map((msg, index) => {
            const isMe = msg.user_id === user.id;
            const isCommand = msg.type === "command";
            const showHeader = index === 0 || messages[index - 1].user_id !== msg.user_id;

            return (
              <div key={msg.id || index} className={`group flex gap-3 ${isMe ? "flex-row-reverse" : ""}`}>
                {showHeader && (
                  <div className={`w-10 h-10 rounded-full flex-shrink-0 flex items-center justify-center font-bold text-white shadow-md ${isMe ? "bg-gradient-to-br from-indigo-500 to-purple-600" : "bg-gradient-to-br from-emerald-500 to-teal-600"}`}>
                    {msg.username[0].toUpperCase()}
                  </div>
                )}
                {!showHeader && <div className="w-10 flex-shrink-0"></div>}
                <div className={`flex flex-col ${isMe ? "items-end" : "items-start"} max-w-[70%]`}>
                  {showHeader && (
                    <div className="flex items-baseline gap-2 mb-1">
                      <span className="font-semibold text-sm text-zinc-300">{msg.username}</span>
                      <span className="text-[10px] text-zinc-600">
                        {new Date(msg.created_at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
                      </span>
                    </div>
                  )}
                  <div className="flex items-center gap-2 group-hover:gap-2">
                    <button
                      onClick={() => copyMessageContent(msg)}
                      className={`p-1.5 rounded transition-all transform scale-90 hover:scale-100 ${
                        copiedMessageId === msg.id
                          ? "opacity-100 text-emerald-400"
                          : "opacity-70 hover:opacity-100 md:opacity-0 md:group-hover:opacity-100 text-zinc-600 hover:text-zinc-300"
                      }`}
                      title={copiedMessageId === msg.id ? "Kopyalandi" : "Kopyala"}
                    >
                      {copiedMessageId === msg.id ? (
                        <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M20 6 9 17l-5-5"/></svg>
                      ) : (
                        <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>
                      )}
                    </button>
                    {isMe && (
                      <button
                        onClick={() => deleteMessage(msg.id)}
                        className="opacity-0 group-hover:opacity-100 p-1.5 text-zinc-600 hover:text-red-400 rounded transition-all transform scale-90 hover:scale-100"
                        title="Mesaji Sil"
                      >
                        <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>
                      </button>
                    )}
                    <div
                      className={`px-4 py-2.5 rounded-2xl break-words shadow-sm ${
                        isCommand
                          ? isMe
                            ? "bg-indigo-950 border border-indigo-700/60 text-indigo-100 rounded-tr-none font-mono"
                            : "bg-zinc-900 border border-zinc-700 text-zinc-200 rounded-tl-none font-mono"
                          : isMe
                            ? "bg-indigo-600 text-white rounded-tr-none"
                            : "bg-zinc-800 text-zinc-200 rounded-tl-none"
                      }`}
                    >
                      {msg.type === "file" ? (
                        msg.content.match(/\.(jpg|jpeg|png|gif)$/i) ? (
                          <img
                            src={msg.content}
                            alt="Uploaded"
                            className="max-w-full rounded-lg max-h-60 object-cover cursor-pointer hover:opacity-90 transition-opacity"
                            onClick={() => window.open(msg.content, "_blank")}
                          />
                        ) : (
                          <a
                            href={msg.content}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="flex items-center gap-2 hover:underline"
                          >
                            <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>
                            Download File
                          </a>
                        )
                      ) : (
                        <MessageContent content={msg.content} isMe={isMe} />
                      )}
                    </div>
                  </div>
                </div>
              </div>
            );
          })}
          <div ref={messagesEndRef} />
        </div>

        <div className="p-4 bg-zinc-900 border-t border-zinc-800">
          {canRenderMusicPlayer && musicState && (
            <div className="mb-3 overflow-hidden rounded-2xl border border-zinc-700 bg-gradient-to-r from-zinc-900 via-zinc-900 to-indigo-950/50 shadow-xl">
              <div className="flex items-center gap-3 p-3">
                <div className="h-14 w-14 shrink-0 overflow-hidden rounded-xl bg-zinc-800">
                  {musicState.current?.thumbnail ? (
                    <img src={musicState.current.thumbnail} alt={musicState.current.title} className="h-full w-full object-cover" />
                  ) : (
                    <div className="flex h-full w-full items-center justify-center text-zinc-500">♪</div>
                  )}
                </div>

                <div className="min-w-0 flex-1">
                  <div className="truncate text-sm font-semibold text-white">
                    {musicState.current?.title || "Sira bekleniyor"}
                  </div>
                  <div className="mt-0.5 text-xs text-zinc-400">
                    {musicState.current?.requestedBy ? `Ekleyen: ${musicState.current.requestedBy}` : "Muzik botu"}
                    <span className="mx-2 text-zinc-600">•</span>
                    {musicState.isPaused ? "Duraklatildi" : musicState.isPlaying ? "Caliyor" : "Hazir"}
                    {musicState.current && (
                      <>
                        <span className="mx-2 text-zinc-600">•</span>
                        {currentPrefetchStatus}
                      </>
                    )}
                  </div>
                </div>

                <div className="hidden items-center gap-2 sm:flex">
                  <button disabled={!canControlCurrent} onClick={() => sendMusicControl("toggle")} className="rounded-lg bg-zinc-800 p-2 text-zinc-200 hover:bg-zinc-700 disabled:cursor-not-allowed disabled:opacity-50">
                    {musicState.isPaused ? "▶" : "⏸"}
                  </button>
                  <button disabled={!canControlCurrent} onClick={() => sendMusicControl("skip")} className="rounded-lg bg-zinc-800 p-2 text-zinc-200 hover:bg-zinc-700 disabled:cursor-not-allowed disabled:opacity-50">⏭</button>
                  <button disabled={!canControlCurrent} onClick={() => sendMusicControl("stop")} className="rounded-lg bg-zinc-800 p-2 text-zinc-200 hover:bg-red-700/60 disabled:cursor-not-allowed disabled:opacity-50">⏹</button>
                </div>
              </div>

              <div className="px-3 pb-3">
                <input
                  type="range"
                  min={0}
                  max={Math.max(1, currentDuration)}
                  step={1}
                  value={Math.max(0, Math.min(Math.floor(effectiveSeekValue), Math.max(1, currentDuration)))}
                  disabled={!canSeekCurrent}
                  onChange={(e) => setSeekDragValue(Number(e.target.value))}
                  onMouseUp={(e) => {
                    if (!canSeekCurrent) return;
                    const val = Number((e.target as HTMLInputElement).value);
                    setSeekDragValue(null);
                    sendMusicControl("seek", val);
                  }}
                  onTouchEnd={(e) => {
                    if (!canSeekCurrent) return;
                    const val = Number((e.target as HTMLInputElement).value);
                    setSeekDragValue(null);
                    sendMusicControl("seek", val);
                  }}
                  className="w-full accent-emerald-400 disabled:cursor-not-allowed disabled:opacity-50"
                />
                <div className="mt-1 flex items-center justify-between text-[11px] text-zinc-400">
                  <span>{formatClock(effectiveSeekValue)}</span>
                  <span>{currentDuration > 0 ? formatClock(currentDuration) : "--:--"}</span>
                </div>

                <div className="mt-2 flex items-center gap-2 sm:hidden">
                  <button disabled={!canControlCurrent} onClick={() => sendMusicControl("toggle")} className="rounded-lg bg-zinc-800 px-3 py-1.5 text-xs text-zinc-200 disabled:cursor-not-allowed disabled:opacity-50">
                    {musicState.isPaused ? "Devam" : "Duraklat"}
                  </button>
                  <button disabled={!canControlCurrent} onClick={() => sendMusicControl("skip")} className="rounded-lg bg-zinc-800 px-3 py-1.5 text-xs text-zinc-200 disabled:cursor-not-allowed disabled:opacity-50">Atla</button>
                  <button disabled={!canControlCurrent} onClick={() => sendMusicControl("stop")} className="rounded-lg bg-zinc-800 px-3 py-1.5 text-xs text-zinc-200 disabled:cursor-not-allowed disabled:opacity-50">Durdur</button>
                </div>

                <div className="mt-2 flex items-center gap-3">
                  <span className="text-[11px] text-zinc-400">Ses</span>
                  <input
                    type="range"
                    min={0}
                    max={200}
                    value={Math.max(0, Math.min(200, Number(musicState.volume || 80)))}
                    onChange={(e) => sendMusicControl("volume", Number(e.target.value))}
                    className="w-full accent-indigo-400"
                  />
                  <span className="w-10 text-right text-[11px] text-zinc-400">{Math.round(musicState.volume || 0)}%</span>
                </div>

                {musicState.queue.length > 0 && (
                  <div className="mt-2 rounded-lg border border-zinc-800 bg-zinc-950/70 p-2">
                    <div className="mb-1 text-[11px] uppercase tracking-wider text-zinc-500">Sıradaki</div>
                    <div className="max-h-28 space-y-1 overflow-y-auto pr-1">
                      {musicState.queue.slice(0, 8).map((item, idx) => (
                        <div key={`${item.id}-${idx}`} className="flex items-center justify-between gap-2 text-xs text-zinc-300">
                          <span className="truncate">{idx + 1}. {item.title}</span>
                          <span className="shrink-0 text-zinc-500">{formatPrefetchStatus(item.prefetchStatus)} • {formatClock(item.durationInSec || 0)}</span>
                        </div>
                      ))}
                    </div>
                  </div>
                )}

                {musicControlError && (
                  <div className="mt-2 rounded-lg border border-amber-700/40 bg-amber-900/20 px-2 py-1 text-xs text-amber-300">
                    {musicControlError}
                  </div>
                )}
              </div>
            </div>
          )}

          {/* Paste Preview */}
          {pastePreview && (
            <div className="mb-3 p-3 bg-zinc-950 rounded-xl border border-zinc-800 shadow-lg animate-in slide-in-from-bottom-2 fade-in duration-200">
              <div className="flex items-center justify-between mb-2">
                <span className="text-xs font-medium text-zinc-400 uppercase tracking-wider">Ekran goruntusu onizleme</span>
                <button
                  onClick={cancelPaste}
                  className="text-zinc-500 hover:text-red-400 transition-colors p-1 hover:bg-zinc-900 rounded"
                  title="Iptal"
                >
                  <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
                </button>
              </div>
              <div className="relative group">
                <img src={pastePreview} alt="Paste preview" className="max-h-40 rounded-lg object-contain border border-zinc-800 bg-zinc-900/50" />
              </div>
              <div className="flex gap-2 mt-3">
                <button
                  onClick={uploadPastedImage}
                  disabled={isUploading}
                  className="flex-1 py-2 bg-indigo-600 hover:bg-indigo-500 disabled:opacity-50 rounded-lg text-sm font-semibold text-white transition-all shadow-lg shadow-indigo-500/20"
                >
                  {isUploading ? "Yukleniyor..." : "Gonder"}
                </button>
              </div>
            </div>
          )}
          <form onSubmit={handleSendMessage} className="flex items-center gap-3">
            <button
              type="button"
              onClick={() => fileInputRef.current?.click()}
              className="p-3 bg-zinc-800 hover:bg-zinc-700 rounded-xl text-zinc-400 hover:text-white transition-all"
              title="Upload File"
            >
              <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/></svg>
            </button>
            <input type="file" ref={fileInputRef} className="hidden" onChange={handleFileUpload} />

            <div className="flex-1 relative">
              {showCommandSuggestions && (
                <div className="absolute bottom-full left-0 right-0 mb-2 overflow-hidden rounded-xl border border-zinc-800 bg-zinc-950/95 shadow-2xl backdrop-blur">
                  {filteredCommands.map((item, index) => {
                    const isActive = index === activeCommandIndex;

                    return (
                      <button
                        key={item.command}
                        type="button"
                        onMouseDown={(e) => {
                          e.preventDefault();
                          applyCommandSuggestion(index);
                        }}
                        className={`flex w-full items-start justify-between gap-3 px-4 py-3 text-left transition-colors ${
                          isActive ? "bg-zinc-800 text-white" : "text-zinc-300 hover:bg-zinc-900"
                        }`}
                      >
                        <div>
                          <div className="text-sm font-semibold">{item.command}</div>
                          <div className="mt-0.5 text-xs text-zinc-500">{item.description}</div>
                        </div>
                        <div className="text-[11px] text-zinc-500">{item.usage}</div>
                      </button>
                    );
                  })}
                </div>
              )}

              <input
                type="text"
                value={inputValue}
                onChange={(e) => setInputValue(e.target.value)}
                onKeyDown={(e) => {
                  if (showCommandSuggestions) {
                    if (e.key === "ArrowDown") {
                      e.preventDefault();
                      setActiveCommandIndex((prev) => (prev + 1) % filteredCommands.length);
                      return;
                    }

                    if (e.key === "ArrowUp") {
                      e.preventDefault();
                      setActiveCommandIndex((prev) => (prev - 1 + filteredCommands.length) % filteredCommands.length);
                      return;
                    }

                    if ((e.key === "Tab" || e.key === "Enter") && filteredCommands[activeCommandIndex]) {
                      const trimmed = inputValue.trim();
                      const hasArguments = trimmed.includes(" ");

                      if (e.key === "Tab" || !hasArguments) {
                        e.preventDefault();
                        applyCommandSuggestion(activeCommandIndex);
                        return;
                      }
                    }

                    if (e.key === "Escape") {
                      e.preventDefault();
                      setInputValue((prev) => prev.replace(/^\/[\w-]*/, "/"));
                      setActiveCommandIndex(0);
                      return;
                    }
                  }

                  if (e.key === "Enter" && !e.shiftKey && inputValue.trim()) {
                    e.preventDefault();
                    handleSendMessage(e as unknown as React.FormEvent);
                  }
                }}
                placeholder={
                  !isConnected 
                    ? "Bağlanıyor..." 
                    : isUploading 
                    ? "Uploading..." 
                    : `Message #${roomDisplayName.toLowerCase()}`
                }
                disabled={isUploading || !isConnected}
                className={`w-full bg-zinc-950 text-white rounded-xl px-4 py-3.5 focus:outline-none focus:ring-2 focus:ring-indigo-500/50 border placeholder-zinc-600 shadow-inner ${
                  isConnected ? "border-zinc-800" : "border-yellow-600/50"
                }`}
              />
              {!isConnected && (
                <div className="absolute right-3 top-1/2 -translate-y-1/2">
                  <div className="w-2 h-2 bg-yellow-500 rounded-full animate-pulse" title="Bağlanıyor..."></div>
                </div>
              )}
            </div>

            <button
              type="submit"
              disabled={!inputValue.trim() || isUploading || !isConnected}
              className="p-3 bg-indigo-600 hover:bg-indigo-500 disabled:opacity-50 disabled:cursor-not-allowed rounded-xl text-white transition-all shadow-lg shadow-indigo-500/20"
            >
              <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><line x1="22" y1="2" x2="11" y2="13"/><polygon points="22 2 15 22 11 13 2 9 22 2"/></svg>
            </button>
          </form>
          <p className="mt-2 text-[10px] text-zinc-500">
            Muzik komutlari icin <span className="text-zinc-400">/help</span> yaz. <span className="text-zinc-600">Tab ile oneri sec, Enter ile gonder.</span>
          </p>
        </div>
      </div>

      {/* Settings Modal */}
      {showSettings && (
        <div className="fixed inset-0 bg-black/80 backdrop-blur-sm z-50 flex items-center justify-center p-4" onClick={() => setShowSettings(false)}>
          <div className="bg-zinc-900 border border-zinc-700 rounded-xl w-full max-w-sm p-6 shadow-2xl" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between mb-6">
              <h2 className="text-xl font-bold text-white">Ayarlar</h2>
              <button
                onClick={() => setShowSettings(false)}
                className="text-zinc-500 hover:text-white transition-colors"
              >
                <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>
                </svg>
              </button>
            </div>

            {/* Username Change */}
            <div className="space-y-4">
              <div>
                <label className="text-xs text-zinc-400 uppercase font-semibold mb-2 block">Kullanici Adi</label>
                <input
                  type="text"
                  value={newUsername}
                  onChange={(e) => setNewUsername(e.target.value)}
                  placeholder="Yeni kullanici adi"
                  maxLength={20}
                  className="w-full bg-zinc-800 text-white rounded-lg px-4 py-3 border border-zinc-600 focus:outline-none focus:border-indigo-500 transition-colors"
                />
                {usernameError && (
                  <p className="text-red-400 text-xs mt-2">{usernameError}</p>
                )}
                <p className="text-zinc-500 text-xs mt-2">{newUsername.length}/20 karakter</p>
              </div>

              <button
                onClick={updateUsername}
                disabled={isUpdatingUsername || !newUsername.trim() || newUsername === user?.username}
                className="w-full py-3 bg-indigo-600 hover:bg-indigo-500 disabled:opacity-50 disabled:cursor-not-allowed rounded-lg text-white font-medium transition-colors"
              >
                {isUpdatingUsername ? "Guncelleniyor..." : "Kaydet"}
              </button>
            </div>

            {/* Divider */}
            <div className="border-t border-zinc-700 my-6"></div>

            {/* Microphone Settings */}
            <div className="space-y-4">
              <div className="flex items-center justify-between mb-2">
                <label className="text-xs text-zinc-400 uppercase font-semibold">Mikrofon Hassasiyeti</label>
                <span className="text-xs font-mono text-zinc-500">{noiseThreshold} dB</span>
              </div>
              <p className="text-[10px] text-zinc-500 mb-3">
                Mikrofonunuzun hangi ses seviyesinde açılacağını belirleyin. Oyun sesleri (CS:GO vb.) karşıya gidiyorsa bu çubuğu <b>sağa</b> kaydırın. Fısıltınız duyulmuyorsa <b>sola</b> kaydırın. (Sadece yeni sesli odaya bağlandığınızda aktif olur.)
              </p>
              
              <input
                type="range"
                min="-80"
                max="-20"
                step="1"
                value={noiseThreshold}
                onChange={(e) => saveNoiseThreshold(parseInt(e.target.value))}
                className="w-full h-2 bg-zinc-700 rounded-lg appearance-none cursor-pointer accent-indigo-500"
              />
              <div className="flex justify-between text-[10px] text-zinc-600 font-medium">
                <span>Çok Hassas (-80)</span>
                <span>Normal (-42)</span>
                <span>Az Hassas (-20)</span>
              </div>
            </div>

            {/* Divider */}
            <div className="border-t border-zinc-700 my-6"></div>

            {/* Logout */}
            <button
              onClick={() => {
                localStorage.clear();
                router.push("/");
              }}
              className="w-full py-3 bg-red-600/20 hover:bg-red-600/40 text-red-400 rounded-lg font-medium transition-colors flex items-center justify-center gap-2"
            >
              <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><polyline points="16 17 21 12 16 7"/><line x1="21" x2="9" y1="12" y2="12"/>
              </svg>
              Cikis Yap
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

// Link Preview Cache
const linkPreviewCache: { [url: string]: LinkPreview | null } = {};

interface LinkPreview {
  url: string;
  title: string;
  description?: string | null;
  image?: string | null;
  favicon?: string | null;
  siteName?: string;
}

// Helper component to render message content with link detection
function MessageContent({ content, isMe }: { content: string; isMe: boolean }) {
  const [previews, setPreviews] = useState<{ [url: string]: LinkPreview | null }>({});
  const API_URL = process.env.NEXT_PUBLIC_API_URL || "http://localhost:3001";
  
  // URL regex pattern
  const urlRegex = /(https?:\/\/[^\s<]+[^<.,:;"')\]\s])/g;
  
  // Extract URLs from content
  const urls = content.match(urlRegex) || [];
  
  // Fetch link previews
  useEffect(() => {
    urls.forEach(async (url) => {
      // Skip if already cached
      if (linkPreviewCache[url] !== undefined) {
        setPreviews(prev => ({ ...prev, [url]: linkPreviewCache[url] }));
        return;
      }
      
      try {
        const res = await fetch(`${API_URL}/api/link-preview?url=${encodeURIComponent(url)}`);
        if (res.ok) {
          const data = await res.json();
          linkPreviewCache[url] = data;
          setPreviews(prev => ({ ...prev, [url]: data }));
        } else {
          linkPreviewCache[url] = null;
        }
      } catch {
        linkPreviewCache[url] = null;
      }
    });
  }, [content, API_URL]);
  
  // Split content into parts (text and links)
  const parts: { type: 'text' | 'link'; content: string }[] = [];
  let lastIndex = 0;
  let match;
  const regex = new RegExp(urlRegex);
  
  while ((match = regex.exec(content)) !== null) {
    // Add text before the link
    if (match.index > lastIndex) {
      parts.push({ type: 'text', content: content.slice(lastIndex, match.index) });
    }
    // Add the link
    parts.push({ type: 'link', content: match[0] });
    lastIndex = regex.lastIndex;
  }
  // Add remaining text
  if (lastIndex < content.length) {
    parts.push({ type: 'text', content: content.slice(lastIndex) });
  }
  
  // If no links found, return plain text
  if (parts.length === 0) {
    return <span>{content}</span>;
  }
  
  return (
    <div className="space-y-2">
      <div className="whitespace-pre-wrap break-words">
        {parts.map((part, i) => (
          part.type === 'link' ? (
            <a
              key={i}
              href={part.content}
              target="_blank"
              rel="noopener noreferrer"
              className={`underline hover:opacity-80 transition-opacity ${isMe ? 'text-blue-200' : 'text-blue-400'}`}
            >
              {part.content}
            </a>
          ) : (
            <span key={i}>{part.content}</span>
          )
        ))}
      </div>
      
      {/* Link Previews */}
      {urls.map((url, i) => {
        const preview = previews[url];
        if (!preview) return null;
        
        return (
          <a
            key={i}
            href={preview.url}
            target="_blank"
            rel="noopener noreferrer"
            className={`block mt-2 rounded-lg overflow-hidden border transition-all hover:opacity-90 ${
              isMe ? 'border-indigo-500/30 bg-indigo-700/30' : 'border-zinc-700 bg-zinc-900/50'
            }`}
          >
            {preview.image && (
              <div className="w-full h-32 overflow-hidden bg-zinc-900">
                <img
                  src={preview.image}
                  alt={preview.title}
                  className="w-full h-full object-cover"
                  onError={(e) => (e.currentTarget.style.display = 'none')}
                />
              </div>
            )}
            <div className="p-3">
              <div className="flex items-center gap-2 mb-1">
                {preview.favicon && (
                  <img
                    src={preview.favicon}
                    alt=""
                    className="w-4 h-4 rounded"
                    onError={(e) => (e.currentTarget.style.display = 'none')}
                  />
                )}
                <span className={`text-xs ${isMe ? 'text-indigo-300' : 'text-zinc-500'}`}>
                  {preview.siteName || new URL(preview.url).hostname}
                </span>
              </div>
              <div className={`font-medium text-sm ${isMe ? 'text-white' : 'text-zinc-200'}`}>
                {preview.title}
              </div>
              {preview.description && (
                <div className={`text-xs mt-1 line-clamp-2 ${isMe ? 'text-indigo-200/70' : 'text-zinc-400'}`}>
                  {preview.description}
                </div>
              )}
            </div>
          </a>
        );
      })}
    </div>
  );
}

export default function ChatPage() {
  return (
    <Suspense fallback={<div className="flex h-screen items-center justify-center bg-zinc-950 text-white">Loading chat...</div>}>
      <ChatContent />
    </Suspense>
  );
}
