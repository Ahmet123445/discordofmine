"use client";

import { useEffect, useState, useRef, Suspense } from "react";
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
  type: "text" | "file";
  fileUrl?: string;
  fileName?: string;
  room_id?: string;
}

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
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const scrollToBottom = () => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  };

  useEffect(() => {
    scrollToBottom();
  }, [messages]);

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

  useEffect(() => {
    const token = localStorage.getItem("token");
    const storedUser = localStorage.getItem("user");

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
    });

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
      }
    });

    newSocket.on("message-deleted", (data: { id: number; roomId?: string }) => {
      if (data.roomId && data.roomId !== roomId) return;
      setMessages((prev) => prev.filter((m) => m.id !== data.id));
    });

    return () => {
      setIsConnected(false);
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
    
    if (!user) {
      console.error("Cannot send message: user not set");
      alert("Kullanıcı bilgisi bulunamadı, lütfen tekrar giriş yapın.");
      return;
    }
    
    if (!roomId) {
      console.error("Cannot send message: roomId not set");
      return;
    }

    console.log("Sending message:", { content: inputValue, user, roomId });
    socket.emit("send-message", {
      content: inputValue,
      user: user,
      type: "text",
      roomId,
    });

    setInputValue("");
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
                        isMe
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
                        msg.content
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
              <input
                type="text"
                value={inputValue}
                onChange={(e) => setInputValue(e.target.value)}
                onKeyDown={(e) => {
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

// Helper component to render message content with link detection
export default function ChatPage() {
  return (
    <Suspense fallback={<div className="flex h-screen items-center justify-center bg-zinc-950 text-white">Loading chat...</div>}>
      <ChatContent />
    </Suspense>
  );
}
