"use client";

import { useEffect, useState, useRef } from "react";
import { useRouter } from "next/navigation";
import io, { Socket } from "socket.io-client";
import VoiceChat from "@/components/VoiceChat";

interface Message {
  id: number;
  content: string;
  username: string;
  user_id: number;
  created_at: string;
  type: 'text' | 'file';
  fileUrl?: string; // Optional for real-time
  fileName?: string;
}

export default function ChatPage() {
  const router = useRouter();
  const [user, setUser] = useState<{ id: number, username: string } | null>(null);
  const [socket, setSocket] = useState<Socket | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [inputValue, setInputValue] = useState("");
  const [isUploading, setIsUploading] = useState(false);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Scroll to bottom
  const scrollToBottom = () => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  };
  
  // ... useEffects ...

  const handleSendMessage = (e: React.FormEvent) => {
    e.preventDefault();
    if (!inputValue.trim() || !socket || !user) return;

    socket.emit("send-message", {
      content: inputValue,
      user: user,
      type: 'text'
    });

    setInputValue("");
  };

  const handleFileUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file || !socket || !user) return;

    setIsUploading(true);
    const formData = new FormData();
    formData.append("file", file);

    try {
      const res = await fetch("http://localhost:3001/api/upload", {
        method: "POST",
        body: formData,
      });
      const data = await res.json();

      if (data.success) {
        // Send socket message with type 'file'
        // We store the full URL in 'content' for simplicity with existing DB schema
        const fullUrl = `http://localhost:3001${data.url}`;
        
        socket.emit("send-message", {
          content: fullUrl, 
          user: user,
          type: 'file',
          fileUrl: fullUrl,
          fileName: data.filename
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
      {/* ... Sidebar ... */}
      
      {/* Main Chat Area */}
      <div className="flex-1 flex flex-col min-w-0">
        {/* ... Header ... */}
        
        <div className="flex-1 p-6 overflow-y-auto space-y-6 scrollbar-thin scrollbar-thumb-zinc-700 scrollbar-track-transparent">
          {messages.length === 0 && (
             <div className="text-zinc-500 text-center text-sm my-10">
               No messages yet. Say hello! 👋
             </div>
          )}
          
          {messages.map((msg, index) => {
            const isMe = msg.user_id === user.id;
            const showHeader = index === 0 || messages[index - 1].user_id !== msg.user_id;

            return (
              <div key={index} className={`flex flex-col ${isMe ? "items-end" : "items-start"}`}>
                {showHeader && (
                  <div className="flex items-baseline gap-2 mb-1">
                    <span className="font-bold text-zinc-300 text-sm">{msg.username}</span>
                    <span className="text-xs text-zinc-500">
                      {new Date(msg.created_at).toLocaleTimeString([], {hour: '2-digit', minute:'2-digit'})}
                    </span>
                  </div>
                )}
                <div className={`px-4 py-2 rounded-lg max-w-[80%] break-words ${
                  isMe 
                    ? "bg-blue-600 text-white rounded-br-none" 
                    : "bg-zinc-700 text-zinc-100 rounded-bl-none"
                }`}>
                  {msg.type === 'file' ? (
                     msg.content.match(/\.(jpg|jpeg|png|gif)$/i) ? (
                        <div className="flex flex-col gap-1">
                          <img 
                            src={msg.content} 
                            alt="Uploaded" 
                            className="max-w-full rounded-md max-h-60 object-cover cursor-pointer hover:opacity-90 transition-opacity"
                            onClick={() => window.open(msg.content, '_blank')}
                          />
                        </div>
                     ) : (
                        <a 
                          href={msg.content} 
                          target="_blank" 
                          rel="noopener noreferrer" 
                          className="flex items-center gap-2 hover:underline text-blue-200"
                        >
                          <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/><polyline points="10 9 9 9 8 9"/></svg>
                          Download File
                        </a>
                     )
                  ) : (
                    msg.content
                  )}
                </div>
              </div>
            );
          })}
          <div ref={messagesEndRef} />
        </div>

        <div className="p-4 bg-zinc-800 border-t border-zinc-700">
          <form onSubmit={handleSendMessage} className="relative flex items-center gap-2">
            <button
              type="button"
              onClick={() => fileInputRef.current?.click()}
              className="p-3 bg-zinc-700 rounded-lg text-zinc-400 hover:text-white transition-colors"
              title="Upload File"
            >
              <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/></svg>
            </button>
            <input 
              type="file" 
              ref={fileInputRef} 
              className="hidden" 
              onChange={handleFileUpload}
            />
            
            <input
              type="text"
              value={inputValue}
              onChange={(e) => setInputValue(e.target.value)}
              placeholder={isUploading ? "Uploading..." : "Message #general"}
              disabled={isUploading}
              className="flex-1 bg-zinc-900 text-white rounded-lg pl-4 pr-12 py-3 focus:outline-none focus:ring-1 focus:ring-blue-500 border border-zinc-700 placeholder-zinc-500"
            />
            <button 
              type="submit"
              disabled={!inputValue.trim() || isUploading}
              className="absolute right-3 top-3 text-blue-500 hover:text-blue-400 disabled:opacity-50 disabled:cursor-not-allowed"
            >
              <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><line x1="22" y1="2" x2="11" y2="13"/><polygon points="22 2 15 22 11 13 2 9 22 2"/></svg>
            </button>
          </form>
        </div>
      </div>
    </div>
  );
}


export default function ChatPage() {
  const router = useRouter();
  const [user, setUser] = useState<{ id: number, username: string } | null>(null);
  const [socket, setSocket] = useState<Socket | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [inputValue, setInputValue] = useState("");
  const messagesEndRef = useRef<HTMLDivElement>(null);

  // Scroll to bottom
  const scrollToBottom = () => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  };

  useEffect(() => {
    scrollToBottom();
  }, [messages]);

  // Initial Setup
  useEffect(() => {
    const token = localStorage.getItem("token");
    const storedUser = localStorage.getItem("user");

    if (!token || !storedUser) {
      router.push("/login");
      return;
    }

    const parsedUser = JSON.parse(storedUser);
    setUser(parsedUser);

    // Fetch previous messages
    fetch("http://localhost:3001/api/messages")
      .then(res => res.json())
      .then(data => setMessages(data))
      .catch(err => console.error("Failed to load history", err));

    // Connect Socket
    const newSocket = io("http://localhost:3001");
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
      type: 'text'
    });

    setInputValue("");
  };

  if (!user) return null;

  return (
    <div className="flex h-screen bg-zinc-900 text-zinc-100">
      {/* Sidebar */}
      <div className="hidden md:flex w-64 bg-zinc-800 border-r border-zinc-700 flex-col">
        <div className="p-4 border-b border-zinc-700 font-bold tracking-wide">DiscordOfMine</div>
        <div className="p-4 flex-1 overflow-y-auto">
          <div className="text-zinc-500 text-xs font-semibold uppercase mb-2">Channels</div>
          <div className="flex items-center gap-2 p-2 bg-zinc-700/50 rounded cursor-pointer text-zinc-100">
            <span className="text-zinc-400">#</span>
            <span>general</span>
          </div>
        </div>
        
        {/* Voice Control Area */}
        <VoiceChat socket={socket} roomId="general" user={user} />

        <div className="p-4 bg-zinc-900/50 border-t border-zinc-700 flex justify-between items-center">
          <div className="flex items-center gap-2">
            <div className="w-8 h-8 rounded-full bg-blue-600 flex items-center justify-center font-bold">
              {user.username[0].toUpperCase()}
            </div>
            <div className="text-sm font-medium">{user.username}</div>
          </div>
          <button 
            onClick={() => {
              localStorage.clear();
              router.push("/login");
            }}
            className="text-zinc-500 hover:text-red-400 transition-colors"
          >
            <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><polyline points="16 17 21 12 16 7"/><line x1="21" x2="9" y1="12" y2="12"/></svg>
          </button>
        </div>
      </div>


      {/* Main Chat Area */}
      <div className="flex-1 flex flex-col min-w-0">
        <div className="h-14 border-b border-zinc-700 flex items-center px-6 bg-zinc-800 shadow-sm">
          <span className="text-zinc-400 mr-2 text-lg">#</span>
          <span className="font-semibold">general</span>
        </div>
        
        <div className="flex-1 p-6 overflow-y-auto space-y-6 scrollbar-thin scrollbar-thumb-zinc-700 scrollbar-track-transparent">
          {messages.length === 0 && (
             <div className="text-zinc-500 text-center text-sm my-10">
               No messages yet. Say hello! 👋
             </div>
          )}
          
          {messages.map((msg, index) => {
            const isMe = msg.user_id === user.id;
            const showHeader = index === 0 || messages[index - 1].user_id !== msg.user_id;

            return (
              <div key={index} className={`flex flex-col ${isMe ? "items-end" : "items-start"}`}>
                {showHeader && (
                  <div className="flex items-baseline gap-2 mb-1">
                    <span className="font-bold text-zinc-300 text-sm">{msg.username}</span>
                    <span className="text-xs text-zinc-500">
                      {new Date(msg.created_at).toLocaleTimeString([], {hour: '2-digit', minute:'2-digit'})}
                    </span>
                  </div>
                )}
                <div className={`px-4 py-2 rounded-lg max-w-[80%] break-words ${
                  isMe 
                    ? "bg-blue-600 text-white rounded-br-none" 
                    : "bg-zinc-700 text-zinc-100 rounded-bl-none"
                }`}>
                  {msg.content}
                </div>
              </div>
            );
          })}
          <div ref={messagesEndRef} />
        </div>

        <div className="p-4 bg-zinc-800 border-t border-zinc-700">
          <form onSubmit={handleSendMessage} className="relative">
            <input
              type="text"
              value={inputValue}
              onChange={(e) => setInputValue(e.target.value)}
              placeholder={`Message #general`}
              className="w-full bg-zinc-900 text-white rounded-lg pl-4 pr-12 py-3 focus:outline-none focus:ring-1 focus:ring-blue-500 border border-zinc-700 placeholder-zinc-500"
            />
            <button 
              type="submit"
              disabled={!inputValue.trim()}
              className="absolute right-3 top-3 text-blue-500 hover:text-blue-400 disabled:opacity-50 disabled:cursor-not-allowed"
            >
              <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><line x1="22" y1="2" x2="11" y2="13"/><polygon points="22 2 15 22 11 13 2 9 22 2"/></svg>
            </button>
          </form>
        </div>
      </div>
    </div>
  );
}
