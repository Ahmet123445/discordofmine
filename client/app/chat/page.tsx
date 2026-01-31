"use client";

import { useEffect, useState, useRef } from "react";
import { useRouter } from "next/navigation";
import io, { Socket } from "socket.io-client";
import dynamic from "next/dynamic";

const VoiceChat = dynamic(() => import("@/components/VoiceChat"), {
  ssr: false,
  loading: () => (
    <div className="flex-1 flex items-center justify-center">
      <div className="text-xs text-zinc-500">Loading...</div>
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
}

export default function ChatPage() {
  const router = useRouter();
  const [user, setUser] = useState<{ id: number; username: string } | null>(null);
  const [socket, setSocket] = useState<Socket | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [inputValue, setInputValue] = useState("");
  const [isUploading, setIsUploading] = useState(false);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const scrollToBottom = () => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  };

  useEffect(() => {
    scrollToBottom();
  }, [messages]);

  useEffect(() => {
    const token = localStorage.getItem("token");
    const storedUser = localStorage.getItem("user");

    if (!token || !storedUser) {
      router.push("/login");
      return;
    }

    const parsedUser = JSON.parse(storedUser);
    setUser(parsedUser);

    const API_URL = process.env.NEXT_PUBLIC_API_URL || "http://localhost:3001";

    fetch(`${API_URL}/api/messages`)
      .then((res) => res.json())
      .then((data) => setMessages(data))
      .catch((err) => console.error("Failed to load history", err));

    const newSocket = io(API_URL);
    setSocket(newSocket);

    newSocket.on("connect", () => {
      console.log("Connected to socket server");
      newSocket.emit("join-room", "general");
    });

    newSocket.on("message-received", (message: Message) => {
      setMessages((prev) => [...prev, message]);
    });

    return () => {
      newSocket.disconnect();
    };
  }, [router]);

  const handleSendMessage = (e: React.FormEvent) => {
    e.preventDefault();
    if (!inputValue.trim() || !socket || !user) return;

    socket.emit("send-message", {
      content: inputValue,
      user: user,
      type: "text",
    });

    setInputValue("");
  };

  const handleFileUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file || !socket || !user) return;

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

  if (!user) return null;

  return (
    <div className="flex h-screen bg-zinc-900 text-zinc-100">
      {/* Sidebar - Redesigned */}
      <div className="hidden md:flex w-72 bg-gradient-to-b from-zinc-800 to-zinc-900 border-r border-zinc-700/50 flex-col">
        {/* Header */}
        <div className="p-4 border-b border-zinc-700/50">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 bg-gradient-to-br from-indigo-500 to-purple-600 rounded-xl flex items-center justify-center shadow-lg shadow-indigo-500/20">
              <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="text-white"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>
            </div>
            <div>
              <h1 className="font-bold text-lg tracking-tight">V A T A N A S K I</h1>
              <p className="text-xs text-zinc-500">Private Server</p>
            </div>
          </div>
        </div>

        {/* Text Channels */}
        <div className="p-3">
          <div className="px-2 py-1.5 flex items-center justify-between">
            <span className="text-zinc-500 text-xs font-semibold uppercase tracking-wider">Text Channels</span>
          </div>
          <div className="space-y-0.5 mt-1">
            <div className="flex items-center gap-2 px-2 py-1.5 bg-zinc-700/50 rounded-md cursor-pointer text-white">
              <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="text-zinc-400"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>
              <span className="text-sm font-medium">general</span>
            </div>
          </div>
        </div>

        {/* Voice Channels - Managed by VoiceChat Component */}
        <div className="flex-1 flex flex-col p-3 pt-0 overflow-hidden">
          <VoiceChat socket={socket} roomId="general" user={user} />
        </div>

        {/* User Panel */}
        <div className="p-3 bg-zinc-900/80 border-t border-zinc-700/50">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <div className="relative">
                <div className="w-9 h-9 rounded-full bg-gradient-to-br from-indigo-500 to-purple-600 flex items-center justify-center font-bold text-white shadow-lg">
                  {user.username[0].toUpperCase()}
                </div>
                <div className="absolute -bottom-0.5 -right-0.5 w-3.5 h-3.5 bg-green-500 rounded-full border-2 border-zinc-900"></div>
              </div>
              <div>
                <div className="text-sm font-medium">{user.username}</div>
                <div className="text-xs text-zinc-500">Online</div>
              </div>
            </div>
            <div className="flex gap-1">
              <button
                onClick={() => {
                  localStorage.clear();
                  router.push("/login");
                }}
                className="p-2 text-zinc-500 hover:text-red-400 hover:bg-zinc-800 rounded-md transition-all"
                title="Logout"
              >
                <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><polyline points="16 17 21 12 16 7"/><line x1="21" x2="9" y1="12" y2="12"/></svg>
              </button>
            </div>
          </div>
        </div>
      </div>

      {/* Main Chat Area */}
      <div className="flex-1 flex flex-col min-w-0">
        <div className="h-14 border-b border-zinc-700/50 flex items-center px-6 bg-zinc-800/50 backdrop-blur-sm">
          <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="text-zinc-500 mr-2"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>
          <span className="font-semibold">general</span>
          <span className="ml-3 text-xs text-zinc-500">Welcome to the server!</span>
        </div>

        <div className="flex-1 p-6 overflow-y-auto space-y-4">
          {messages.length === 0 && (
            <div className="flex flex-col items-center justify-center h-full text-center">
              <div className="w-16 h-16 bg-zinc-800 rounded-full flex items-center justify-center mb-4">
                <svg xmlns="http://www.w3.org/2000/svg" width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" className="text-zinc-600"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>
              </div>
              <h3 className="text-lg font-semibold text-zinc-300">Welcome to #general!</h3>
              <p className="text-sm text-zinc-500 mt-1">This is the start of the conversation.</p>
            </div>
          )}

          {messages.map((msg, index) => {
            const isMe = msg.user_id === user.id;
            const showHeader = index === 0 || messages[index - 1].user_id !== msg.user_id;

            return (
              <div key={index} className={`flex gap-3 ${isMe ? "flex-row-reverse" : ""}`}>
                {showHeader && (
                  <div className={`w-10 h-10 rounded-full flex-shrink-0 flex items-center justify-center font-bold text-white ${isMe ? "bg-gradient-to-br from-indigo-500 to-purple-600" : "bg-gradient-to-br from-emerald-500 to-teal-600"}`}>
                    {msg.username[0].toUpperCase()}
                  </div>
                )}
                {!showHeader && <div className="w-10 flex-shrink-0"></div>}
                <div className={`flex flex-col ${isMe ? "items-end" : "items-start"}`}>
                  {showHeader && (
                    <div className="flex items-baseline gap-2 mb-1">
                      <span className="font-semibold text-sm text-zinc-200">{msg.username}</span>
                      <span className="text-xs text-zinc-500">
                        {new Date(msg.created_at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
                      </span>
                    </div>
                  )}
                  <div
                    className={`px-4 py-2.5 rounded-2xl max-w-md break-words ${
                      isMe
                        ? "bg-gradient-to-r from-indigo-600 to-indigo-500 text-white"
                        : "bg-zinc-800 text-zinc-100"
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
            );
          })}
          <div ref={messagesEndRef} />
        </div>

        <div className="p-4 bg-zinc-800/50 border-t border-zinc-700/50">
          <form onSubmit={handleSendMessage} className="flex items-center gap-3">
            <button
              type="button"
              onClick={() => fileInputRef.current?.click()}
              className="p-3 bg-zinc-700 hover:bg-zinc-600 rounded-xl text-zinc-400 hover:text-white transition-all"
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
                placeholder={isUploading ? "Uploading..." : "Message #general"}
                disabled={isUploading}
                className="w-full bg-zinc-900 text-white rounded-xl px-4 py-3 focus:outline-none focus:ring-2 focus:ring-indigo-500/50 border border-zinc-700 placeholder-zinc-500"
              />
            </div>

            <button
              type="submit"
              disabled={!inputValue.trim() || isUploading}
              className="p-3 bg-indigo-600 hover:bg-indigo-500 disabled:opacity-50 disabled:cursor-not-allowed rounded-xl text-white transition-all"
            >
              <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><line x1="22" y1="2" x2="11" y2="13"/><polygon points="22 2 15 22 11 13 2 9 22 2"/></svg>
            </button>
          </form>
        </div>
      </div>
    </div>
  );
}
