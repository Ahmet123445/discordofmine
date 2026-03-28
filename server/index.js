import { Server as SocketIOServer } from "socket.io";
import { Server as HttpServer } from "http";
import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import db from "./db.js";
import authRoutes from "./routes/auth.js";
import uploadRoutes from "./routes/upload.js";
import path from "path";
import { spawn } from "child_process";
import Peer from "simple-peer";
import wrtc from "@roamhq/wrtc";
import ffmpegPath from "ffmpeg-static";
import fs from "fs";

// Version: 2.0.0 - Database-based session tracking for reliability
dotenv.config();

const app = express();
const port = process.env.PORT || 3001;

app.use(cors());
app.use(express.json());

// Serve uploaded files statically
app.use("/uploads", express.static(path.join(process.cwd(), "uploads")));

app.use("/api/auth", authRoutes);
app.use("/api/upload", uploadRoutes);

// --- API Endpoints ---

// Update Username
app.put("/api/users/:id/username", (req, res) => {
  try {
    const { id } = req.params;
    const { username } = req.body;
    
    if (!username || username.trim().length < 2) {
      return res.status(400).json({ error: "Username must be at least 2 characters" });
    }
    
    if (username.length > 20) {
      return res.status(400).json({ error: "Username must be 20 characters or less" });
    }
    
    // Check if username is taken
    const existing = db.prepare("SELECT id FROM users WHERE username = ? AND id != ?").get(username.trim(), id);
    if (existing) {
      return res.status(409).json({ error: "Username already taken" });
    }
    
    // Update username
    db.prepare("UPDATE users SET username = ? WHERE id = ?").run(username.trim(), id);
    
    // Also update username in existing messages
    db.prepare("UPDATE messages SET username = ? WHERE user_id = ?").run(username.trim(), id);
    
    res.json({ success: true, username: username.trim() });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to update username" });
  }
});

// Get Messages (Filtered by Room)
app.get("/api/messages", (req, res) => {
  try {
    const roomId = req.query.roomId || "general";
    const messages = db.prepare("SELECT * FROM messages WHERE room_id = ? ORDER BY created_at ASC LIMIT 50").all(roomId);
    // Ensure user_id is always a number
    const normalizedMessages = messages.map(msg => ({
      ...msg,
      id: Number(msg.id),
      user_id: Number(msg.user_id)
    }));
    res.json(normalizedMessages);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to fetch messages" });
  }
});

// Delete Message Endpoint
app.delete("/api/messages/:id", (req, res) => {
  try {
    const { id } = req.params;
    const { userId } = req.body;
    
    // Check if message exists and belongs to user
    const message = db.prepare("SELECT * FROM messages WHERE id = ?").get(id);
    
    if (!message) {
      return res.status(404).json({ error: "Message not found" });
    }
    
    if (message.user_id !== userId) {
      return res.status(403).json({ error: "Not authorized to delete this message" });
    }
    
    db.prepare("DELETE FROM messages WHERE id = ?").run(id);
    
    // Broadcast deletion to all clients
    io.emit("message-deleted", { id: Number(id), roomId: message.room_id });
    
    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to delete message" });
  }
});

// Get Rooms with stats
app.get("/api/rooms", (req, res) => {
  try {
    const rooms = db.prepare("SELECT * FROM rooms ORDER BY created_at ASC").all();
    
    // Add stats
    const stats = getRoomStats();
    const roomsWithStats = rooms.map(room => ({
      id: room.id,
      name: room.name,
      created_by: room.created_by,
      created_at: room.created_at,
      isPrivate: !!room.password, // Don't send password, just flag
      onlineCount: stats[room.id]?.count || 0,
      users: stats[room.id]?.users || []
    }));
    
    res.json(roomsWithStats);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to fetch rooms" });
  }
});

// Verify Room Password
app.post("/api/rooms/verify", (req, res) => {
  try {
    const { roomId, password } = req.body;
    const room = db.prepare("SELECT password FROM rooms WHERE id = ?").get(roomId);
    
    if (!room) return res.status(404).json({ error: "Room not found" });
    
    // Simple direct comparison
    if (room.password === password) {
      return res.json({ success: true });
    } else {
      return res.status(401).json({ error: "Incorrect password" });
    }
  } catch (err) {
     console.error(err);
     res.status(500).json({ error: "Verification failed" });
  }
});

// Create Room
app.post("/api/rooms", (req, res) => {
  try {
    const { name, userId, password } = req.body;
    if (!name) return res.status(400).json({ error: "Room name required" });

    const id = name.toLowerCase().replace(/[^a-z0-9]/g, "-") + "-" + Date.now().toString().slice(-4);
    
    const createdAt = new Date().toISOString();
    const stmt = db.prepare("INSERT INTO rooms (id, name, created_by, password, created_at) VALUES (?, ?, ?, ?, ?)");
    stmt.run(id, name, userId || 0, password || null, createdAt);
    
    const newRoom = { id, name, created_by: userId || 0, isPrivate: !!password, created_at: createdAt };
    io.emit("room-created", newRoom); // Notify clients
    res.status(201).json(newRoom);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to create room" });
  }
});

// Link Preview - fetch metadata from URL
app.get("/api/link-preview", async (req, res) => {
  try {
    const { url } = req.query;
    if (!url) return res.status(400).json({ error: "URL required" });
    
    // Validate URL
    let parsedUrl;
    try {
      parsedUrl = new URL(url);
    } catch {
      return res.status(400).json({ error: "Invalid URL" });
    }
    
    // Fetch the page with timeout
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5000);
    
    const response = await fetch(parsedUrl.href, {
      signal: controller.signal,
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; LinkPreviewBot/1.0)',
        'Accept': 'text/html'
      }
    });
    clearTimeout(timeout);
    
    if (!response.ok) {
      return res.json({ url: parsedUrl.href, title: parsedUrl.hostname });
    }
    
    const html = await response.text();
    
    // Extract metadata using regex (simple approach)
    const getMetaContent = (property) => {
      const ogMatch = html.match(new RegExp(`<meta[^>]*property=["']og:${property}["'][^>]*content=["']([^"']+)["']`, 'i'));
      if (ogMatch) return ogMatch[1];
      
      const ogMatch2 = html.match(new RegExp(`<meta[^>]*content=["']([^"']+)["'][^>]*property=["']og:${property}["']`, 'i'));
      if (ogMatch2) return ogMatch2[1];
      
      const twitterMatch = html.match(new RegExp(`<meta[^>]*name=["']twitter:${property}["'][^>]*content=["']([^"']+)["']`, 'i'));
      if (twitterMatch) return twitterMatch[1];
      
      return null;
    };
    
    // Get title
    let title = getMetaContent('title');
    if (!title) {
      const titleMatch = html.match(/<title[^>]*>([^<]+)<\/title>/i);
      title = titleMatch ? titleMatch[1].trim() : parsedUrl.hostname;
    }
    
    // Get description
    let description = getMetaContent('description');
    if (!description) {
      const descMatch = html.match(/<meta[^>]*name=["']description["'][^>]*content=["']([^"']+)["']/i);
      description = descMatch ? descMatch[1] : null;
    }
    
    // Get image
    let image = getMetaContent('image');
    if (image && !image.startsWith('http')) {
      image = new URL(image, parsedUrl.origin).href;
    }
    
    // Get favicon
    let favicon = null;
    const iconMatch = html.match(/<link[^>]*rel=["'](?:shortcut )?icon["'][^>]*href=["']([^"']+)["']/i);
    if (iconMatch) {
      favicon = iconMatch[1].startsWith('http') ? iconMatch[1] : new URL(iconMatch[1], parsedUrl.origin).href;
    } else {
      favicon = `${parsedUrl.origin}/favicon.ico`;
    }
    
    res.json({
      url: parsedUrl.href,
      title: title ? title.substring(0, 100) : parsedUrl.hostname,
      description: description ? description.substring(0, 200) : null,
      image,
      favicon,
      siteName: getMetaContent('site_name') || parsedUrl.hostname
    });
  } catch (err) {
    console.error("Link preview error:", err.message);
    try {
      const parsedUrl = new URL(req.query.url);
      res.json({ url: parsedUrl.href, title: parsedUrl.hostname });
    } catch {
      res.status(500).json({ error: "Failed to fetch link preview" });
    }
  }
});

// --- Socket.io ---

const httpServer = new HttpServer(app);
const io = new SocketIOServer(httpServer, {
  cors: {
    origin: "*", 
    methods: ["GET", "POST"]
  },
  // CRITICAL: Ping/Pong settings for stable socket connections
  pingTimeout: 60000,      // 60 seconds
  pingInterval: 20000,     // 20 seconds
  transports: ['websocket', 'polling'],
  allowUpgrades: true
});

const FRAME_SIZE_BYTES = 1920;
const MUSIC_BOT_USERNAME = "Music Bot";
const musicSessions = new Map();
const ytDlpBinary = process.env.YTDLP_PATH || "yt-dlp";
const ytDlpCookiesPath = process.env.YTDLP_COOKIES_PATH || "/opt/discordofmine/server/yt-cookies.txt";
const invidiousSearchInstances = [
  "https://invidious.nerdvpn.de",
  "https://vid.puffyan.us",
  "https://inv.nadeko.net"
];

const getYtDlpBaseArgs = () => {
  const args = [
    "--no-warnings",
    "--extractor-args",
    "youtube:player_client=android,web_safari,tv"
  ];

  if (fs.existsSync(ytDlpCookiesPath)) {
    args.push("--cookies", ytDlpCookiesPath);
  }

  return args;
};

const isYouTubeBotCheckError = (msg = "") => {
  return /sign in to confirm you're not a bot|not a bot/i.test(msg);
};

const buildMusicBotId = (voiceRoomId) => `music-bot:${voiceRoomId}`;
const isMusicBotId = (id) => typeof id === "string" && id.startsWith("music-bot:");

const sendSystemMessage = (roomId, content) => {
  io.to(roomId).emit("message-received", {
    id: Date.now(),
    content,
    user_id: 0,
    username: "System",
    type: "system",
    room_id: roomId,
    created_at: new Date().toISOString()
  });
};

const getVoiceUsers = (voiceRoomId) => usersInVoice[voiceRoomId] || [];
const getHumanVoiceUsers = (voiceRoomId) => getVoiceUsers(voiceRoomId).filter((u) => !isMusicBotId(u.id));

const addMusicBotPresence = (voiceRoomId) => {
  const botId = buildMusicBotId(voiceRoomId);
  if (!usersInVoice[voiceRoomId]) {
    usersInVoice[voiceRoomId] = [];
  }

  const exists = usersInVoice[voiceRoomId].some((u) => u.id === botId);
  if (!exists) {
    usersInVoice[voiceRoomId].push({ id: botId, username: MUSIC_BOT_USERNAME });
    broadcastAllVoiceUsers();
  }

  return botId;
};

const removeMusicBotPresence = (voiceRoomId) => {
  const botId = buildMusicBotId(voiceRoomId);
  const roomUsers = usersInVoice[voiceRoomId];

  if (!roomUsers) return;

  const next = roomUsers.filter((u) => u.id !== botId);
  usersInVoice[voiceRoomId] = next;

  io.to(voiceRoomId).emit("user-left-voice", botId);

  if (next.length === 0) {
    delete usersInVoice[voiceRoomId];
  }

  broadcastAllVoiceUsers();
};

const destroyMusicPeer = (session, userSocketId) => {
  const peer = session.peers.get(userSocketId);
  if (!peer) return;

  try {
    peer.destroy();
  } catch {}

  session.peers.delete(userSocketId);
};

const destroyAllMusicPeers = (session) => {
  for (const userSocketId of session.peers.keys()) {
    destroyMusicPeer(session, userSocketId);
  }
};

const stopCurrentPlayback = (session) => {
  if (!session.ffmpegProcess && !session.sourceProcess) {
    session.buffer = Buffer.alloc(0);
    session.current = null;
    session.isPlaying = false;
    session.isPaused = false;
    return;
  }

  session.isStoppingCurrent = true;

  try {
    session.ffmpegProcess.stdout?.removeAllListeners();
    session.ffmpegProcess.stderr?.removeAllListeners();
  } catch {}

  try {
    session.sourceProcess.stdout?.removeAllListeners();
    session.sourceProcess.stderr?.removeAllListeners();
  } catch {}

  try {
    session.ffmpegProcess.kill("SIGKILL");
  } catch {}

  try {
    session.sourceProcess.kill("SIGKILL");
  } catch {}

  session.ffmpegProcess = null;
  session.sourceProcess = null;
  session.buffer = Buffer.alloc(0);
  session.current = null;
  session.isPlaying = false;
  session.isPaused = false;
};

const closeMusicSession = (voiceRoomId, reason = null) => {
  const session = musicSessions.get(voiceRoomId);
  if (!session) return;

  stopCurrentPlayback(session);
  destroyAllMusicPeers(session);

  try {
    session.track.stop();
  } catch {}

  session.queue = [];
  musicSessions.delete(voiceRoomId);
  removeMusicBotPresence(voiceRoomId);

  if (reason) {
    const serverRoomId = voiceRoomId.substring(0, voiceRoomId.lastIndexOf("-"));
    sendSystemMessage(serverRoomId, reason);
  }
};

const runYtDlpJson = (input) => {
  return new Promise((resolve, reject) => {
    const args = [...getYtDlpBaseArgs(), "--skip-download", "--dump-single-json", input];
    const proc = spawn(ytDlpBinary, args, {
      stdio: ["ignore", "pipe", "pipe"]
    });

    let stdout = "";
    let stderr = "";

    proc.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });

    proc.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });

    proc.on("error", (err) => {
      if (err.code === "ENOENT") {
        reject(new Error("yt-dlp bulunamadi. Sunucuda yt-dlp kurulumu gerekli."));
        return;
      }
      reject(err);
    });

    proc.on("close", (code) => {
      if (code !== 0) {
        reject(new Error(stderr.trim() || `yt-dlp komutu ${code} koduyla sonlandi.`));
        return;
      }

      try {
        resolve(JSON.parse(stdout));
      } catch {
        reject(new Error("yt-dlp JSON cikti parse edilemedi."));
      }
    });
  });
};

const canResolveTrack = async (url) => {
  try {
    await runYtDlpJson(url);
    return true;
  } catch {
    return false;
  }
};

const normalizeYtDlpTrack = (entry) => {
  return {
    title: entry.title || "Bilinmeyen Sarki",
    url: entry.webpage_url || entry.url,
    durationInSec: Number(entry.duration || 0)
  };
};

const searchViaInvidious = async (query, limit = 10) => {
  const encoded = encodeURIComponent(query);

  for (const base of invidiousSearchInstances) {
    try {
      const url = `${base}/api/v1/search?q=${encoded}&type=video`;
      const response = await fetch(url, {
        headers: {
          "accept": "application/json",
          "user-agent": "Mozilla/5.0"
        }
      });

      if (!response.ok) {
        continue;
      }

      const data = await response.json();
      if (!Array.isArray(data)) {
        continue;
      }

      const tracks = data
        .filter((item) => item && (item.type === "video" || item.videoId))
        .slice(0, limit)
        .map((item) => ({
          title: item.title || "Bilinmeyen Sarki",
          url: `https://www.youtube.com/watch?v=${item.videoId}`,
          durationInSec: Number(item.lengthSeconds || 0)
        }));

      if (tracks.length > 0) {
        return tracks;
      }
    } catch {}
  }

  throw new Error("Harici arama servislerinden sonuc alinmadi.");
};

const resolveTrack = async (query) => {
  const trimmed = (query || "").trim();
  const isUrl = /^https?:\/\//i.test(trimmed);
  if (isUrl) {
    const result = await runYtDlpJson(trimmed);
    const entry = Array.isArray(result.entries) ? result.entries.find(Boolean) : result;
    if (!entry) {
      throw new Error("Verilen link cozumlenemedi.");
    }
    return normalizeYtDlpTrack(entry);
  }

  const results = await searchViaInvidious(trimmed, 10);
  if (!results || results.length === 0) {
    throw new Error("Arama sonucu bulunamadi.");
  }

  for (const candidate of results) {
    const ok = await canResolveTrack(candidate.url);
    if (ok) return candidate;
  }

  throw new Error("Arama sonucu bulundu ama oynatilabilir bir kaynak bulunamadi.");
};

const searchTracks = async (query, limit = 5) => {
  return searchViaInvidious(query, limit);
};

const getOrCreateMusicSession = (voiceRoomId) => {
  if (musicSessions.has(voiceRoomId)) {
    return musicSessions.get(voiceRoomId);
  }

  const RTC = wrtc.default || wrtc;
  const audioSource = new RTC.nonstandard.RTCAudioSource();
  const track = audioSource.createTrack();
  const stream = new RTC.MediaStream([track]);
  const botId = addMusicBotPresence(voiceRoomId);

  const session = {
    voiceRoomId,
    botId,
    audioSource,
    track,
    stream,
    queue: [],
    peers: new Map(),
    sourceProcess: null,
    ffmpegProcess: null,
    current: null,
    isPlaying: false,
    isPaused: false,
    isStoppingCurrent: false,
    volume: 80,
    buffer: Buffer.alloc(0)
  };

  musicSessions.set(voiceRoomId, session);
  return session;
};

const connectBotToUser = (voiceRoomId, userSocketId) => {
  const session = musicSessions.get(voiceRoomId);
  if (!session) return;
  if (!io.sockets.sockets.get(userSocketId)) return;
  if (session.peers.has(userSocketId)) return;

  const RTC = wrtc.default || wrtc;
  const peer = new Peer({
    initiator: true,
    trickle: false,
    stream: session.stream,
    wrtc: RTC,
    config: {
      iceServers: [
        { urls: "stun:stun.l.google.com:19302" },
        { urls: "stun:global.stun.twilio.com:3478" }
      ]
    }
  });

  peer.on("signal", (signal) => {
    io.to(userSocketId).emit("user-joined-voice", {
      signal,
      callerID: session.botId,
      username: MUSIC_BOT_USERNAME
    });
  });

  peer.on("error", (err) => {
    console.error(`[MusicBot] Peer error (${voiceRoomId}/${userSocketId}):`, err.message);
    destroyMusicPeer(session, userSocketId);
  });

  peer.on("close", () => {
    destroyMusicPeer(session, userSocketId);
  });

  session.peers.set(userSocketId, peer);
};

const ensureBotConnectedToRoomUsers = (voiceRoomId) => {
  const users = getHumanVoiceUsers(voiceRoomId);
  users.forEach((u) => connectBotToUser(voiceRoomId, u.id));
};

const pumpChunkToRtcSource = (session, chunk) => {
  session.buffer = Buffer.concat([session.buffer, chunk]);

  while (session.buffer.length >= FRAME_SIZE_BYTES) {
    const frameData = session.buffer.subarray(0, FRAME_SIZE_BYTES);
    session.buffer = session.buffer.subarray(FRAME_SIZE_BYTES);

    const arrayBuffer = new ArrayBuffer(FRAME_SIZE_BYTES);
    const view = new Uint8Array(arrayBuffer);
    for (let i = 0; i < FRAME_SIZE_BYTES; i++) {
      view[i] = frameData[i];
    }

    const samples = new Int16Array(arrayBuffer);
    session.audioSource.onData({
      samples,
      sampleRate: 48000,
      bitsPerSample: 16,
      channelCount: 2,
      numberOfFrames: 480
    });
  }
};

const playNextInSession = async (voiceRoomId) => {
  const session = musicSessions.get(voiceRoomId);
  if (!session || session.isPlaying) return;

  const nextTrack = session.queue.shift();
  if (!nextTrack) {
    session.current = null;
    session.isPaused = false;
    return;
  }

  ensureBotConnectedToRoomUsers(voiceRoomId);

  session.current = nextTrack;
  session.isPlaying = true;
  session.isPaused = false;
  session.buffer = Buffer.alloc(0);

  try {
    const ytDlpArgs = [
      ...getYtDlpBaseArgs(),
      "--no-playlist",
      "-f",
      "bestaudio[ext=m4a]/bestaudio/best",
      "-o",
      "-",
      nextTrack.url
    ];

    const sourceProcess = spawn(ytDlpBinary, ytDlpArgs, {
      stdio: ["ignore", "pipe", "pipe"]
    });

    const ffmpegArgs = [
      "-loglevel", "error",
      "-i", "pipe:0",
      "-filter:a", `volume=${Math.max(0, session.volume) / 100}`,
      "-f", "s16le",
      "-ar", "48000",
      "-ac", "2",
      "pipe:1"
    ];

    const ffmpegBinary = process.env.FFMPEG_PATH || ffmpegPath || "ffmpeg";
    const ffmpeg = spawn(ffmpegBinary, ffmpegArgs, {
      stdio: ["pipe", "pipe", "pipe"]
    });

    let sourceFailed = false;
    let sourceErrorText = "";

    session.sourceProcess = sourceProcess;
    session.ffmpegProcess = ffmpeg;
    session.isStoppingCurrent = false;

    sourceProcess.on("error", (err) => {
      console.error("[MusicBot] yt-dlp process error:", err.message);
      try {
        ffmpeg.kill("SIGKILL");
      } catch {}
    });

    sourceProcess.stderr.on("data", (data) => {
      const msg = data.toString().trim();
      if (msg) {
        sourceErrorText += `${msg}\n`;
        console.error("[MusicBot][yt-dlp]", msg);
      }
    });

    sourceProcess.on("close", (code) => {
      if (code !== 0) {
        sourceFailed = true;
      }
    });

    sourceProcess.stdout.pipe(ffmpeg.stdin);

    ffmpeg.stdout.on("data", (chunk) => {
      if (!session.isPaused) {
        pumpChunkToRtcSource(session, chunk);
      }
    });

    ffmpeg.stderr.on("data", (data) => {
      const msg = data.toString().trim();
      if (msg) {
        console.error("[MusicBot][FFmpeg]", msg);
      }
    });

    ffmpeg.on("close", () => {
      session.sourceProcess = null;
      session.ffmpegProcess = null;
      session.buffer = Buffer.alloc(0);
      session.current = null;
      session.isPlaying = false;
      session.isPaused = false;

      const serverRoomId = voiceRoomId.substring(0, voiceRoomId.lastIndexOf("-"));

      if (sourceFailed && !session.isStoppingCurrent) {
        const detail = isYouTubeBotCheckError(sourceErrorText)
          ? " (YouTube bot dogrulamasi engeli - cookie gerekebilir)"
          : "";
        sendSystemMessage(serverRoomId, `Sarki oynatilamadi: ${nextTrack.title}${detail}`);
        session.isStoppingCurrent = false;
        void playNextInSession(voiceRoomId);
        return;
      }

      if (!session.isStoppingCurrent) {
        sendSystemMessage(serverRoomId, `Sarki bitti: ${nextTrack.title}`);
      }

      session.isStoppingCurrent = false;
      void playNextInSession(voiceRoomId);
    });

    const serverRoomId = voiceRoomId.substring(0, voiceRoomId.lastIndexOf("-"));
    sendSystemMessage(serverRoomId, `Caliniyor: ${nextTrack.title}`);
  } catch (err) {
    console.error("[MusicBot] Failed to start track:", err.message);
    session.current = null;
    session.isPlaying = false;
    session.isPaused = false;
    session.buffer = Buffer.alloc(0);

    const serverRoomId = voiceRoomId.substring(0, voiceRoomId.lastIndexOf("-"));
    sendSystemMessage(serverRoomId, `Sarki oynatilamadi: ${nextTrack.title}`);
    void playNextInSession(voiceRoomId);
  }
};

const maybeAutoStopMusicForRoom = (voiceRoomId) => {
  const session = musicSessions.get(voiceRoomId);
  if (!session) return;

  const humans = getHumanVoiceUsers(voiceRoomId);
  if (humans.length === 0) {
    closeMusicSession(voiceRoomId, "Muzik botu odada kimse kalmadigi icin ayrildi.");
  }
};

const getMusicHelpText = () => {
  return [
    "Muzik komutlari:",
    "/play <yt-link veya sarki adi>",
    "/search <sarki adi>",
    "/queue",
    "/skip",
    "/pause",
    "/resume",
    "/stop",
    "/np",
    "/volume <0-200>"
  ].join("\n");
};

const handleMusicCommand = async ({ socket, roomId, user, commandText }) => {
  const [command, ...args] = commandText.trim().split(/\s+/);
  const normalized = command.toLowerCase();
  const voiceRoomId = socketToRoom[socket.id];

  if (normalized === "/help") {
    sendSystemMessage(roomId, getMusicHelpText());
    return true;
  }

  if (!voiceRoomId) {
    sendSystemMessage(roomId, "Muzik komutlari icin once bir voice kanalina katilmalisin.");
    return true;
  }

  if (!voiceRoomId.startsWith(`${roomId}-`)) {
    sendSystemMessage(roomId, "Komut sadece bulundugun odanin voice kanalinda calisir.");
    return true;
  }

  if (normalized === "/search") {
    const query = args.join(" ").trim();
    if (!query) {
      sendSystemMessage(roomId, "Kullanim: /search <sarki adi>");
      return true;
    }

    try {
      const results = await searchTracks(query, 5);

      if (!results || results.length === 0) {
        sendSystemMessage(roomId, `Arama sonucu bulunamadi: ${query}`);
        return true;
      }

      const lines = results.map((item, index) => `${index + 1}. ${item.title}`);
      sendSystemMessage(roomId, `Arama sonuclari (${query}):\n${lines.join("\n")}`);
    } catch (err) {
      const message = err?.message || "";
      if (isYouTubeBotCheckError(message)) {
        sendSystemMessage(roomId, "YouTube arama engeline takildi (bot dogrulamasi). Biraz sonra tekrar dene.");
      } else {
        sendSystemMessage(roomId, "Arama sirasinda bir hata olustu.");
      }
    }

    return true;
  }

  if (normalized === "/play") {
    const query = args.join(" ").trim();
    if (!query) {
      sendSystemMessage(roomId, "Kullanim: /play <yt-link veya sarki adi>");
      return true;
    }

    try {
      const track = await resolveTrack(query);
      const session = getOrCreateMusicSession(voiceRoomId);

      session.queue.push({
        ...track,
        requestedBy: user.username
      });

      sendSystemMessage(roomId, `Kuyruga eklendi: ${track.title}`);
      void playNextInSession(voiceRoomId);
    } catch (err) {
      const message = err?.message || "Bilinmeyen hata";
      console.error("[MusicBot] /play error:", message);
      if (isYouTubeBotCheckError(message)) {
        sendSystemMessage(roomId, "YouTube bu parca icin bot dogrulamasi istiyor. Baska bir sarki dene veya sunucuya yt-dlp cookie tanimla.");
      } else {
        sendSystemMessage(roomId, `Parca bulunamadi/oynatilamadi: ${query}`);
      }
    }

    return true;
  }

  const session = musicSessions.get(voiceRoomId);

  if (normalized === "/queue") {
    if (!session || (!session.current && session.queue.length === 0)) {
      sendSystemMessage(roomId, "Kuyruk bos.");
      return true;
    }

    const lines = [];
    if (session.current) {
      lines.push(`Simdi calan: ${session.current.title}`);
    }

    if (session.queue.length > 0) {
      lines.push("Siradakiler:");
      session.queue.slice(0, 10).forEach((item, index) => {
        lines.push(`${index + 1}. ${item.title}`);
      });
    }

    sendSystemMessage(roomId, lines.join("\n"));
    return true;
  }

  if (normalized === "/np") {
    if (!session || !session.current) {
      sendSystemMessage(roomId, "Su an calan bir parca yok.");
      return true;
    }

    sendSystemMessage(roomId, `Simdi calan: ${session.current.title}`);
    return true;
  }

  if (normalized === "/skip") {
    if (!session || !session.isPlaying) {
      sendSystemMessage(roomId, "Atlanacak bir parca yok.");
      return true;
    }

    stopCurrentPlayback(session);
    sendSystemMessage(roomId, "Parca atlandi.");
    void playNextInSession(voiceRoomId);
    return true;
  }

  if (normalized === "/pause") {
    if (!session || !session.ffmpegProcess || session.isPaused) {
      sendSystemMessage(roomId, "Duraklatilacak bir oynatma yok.");
      return true;
    }

    if (process.platform === "win32") {
      sendSystemMessage(roomId, "Pause komutu bu platformda desteklenmiyor.");
      return true;
    }

    try {
      session.ffmpegProcess.kill("SIGSTOP");
      session.isPaused = true;
      sendSystemMessage(roomId, "Muzik duraklatildi.");
    } catch {
      sendSystemMessage(roomId, "Muzik duraklatilamadi.");
    }

    return true;
  }

  if (normalized === "/resume") {
    if (!session || !session.ffmpegProcess || !session.isPaused) {
      sendSystemMessage(roomId, "Devam ettirilecek bir oynatma yok.");
      return true;
    }

    if (process.platform === "win32") {
      sendSystemMessage(roomId, "Resume komutu bu platformda desteklenmiyor.");
      return true;
    }

    try {
      session.ffmpegProcess.kill("SIGCONT");
      session.isPaused = false;
      sendSystemMessage(roomId, "Muzik devam ediyor.");
    } catch {
      sendSystemMessage(roomId, "Muzik devam ettirilemedi.");
    }

    return true;
  }

  if (normalized === "/stop") {
    if (!session) {
      sendSystemMessage(roomId, "Aktif muzik oturumu yok.");
      return true;
    }

    closeMusicSession(voiceRoomId, "Muzik durduruldu.");
    return true;
  }

  if (normalized === "/volume") {
    if (!session) {
      sendSystemMessage(roomId, "Aktif muzik oturumu yok.");
      return true;
    }

    const raw = Number(args[0]);
    if (Number.isNaN(raw) || raw < 0 || raw > 200) {
      sendSystemMessage(roomId, "Kullanim: /volume <0-200>");
      return true;
    }

    session.volume = raw;
    sendSystemMessage(roomId, `Volume ayarlandi: ${raw}%`);
    return true;
  }

  return false;
};

// Health check endpoint
app.get("/", (req, res) => {
  res.send("Server is running - " + new Date().toISOString());
});

// Keep-alive endpoint for external pinging
app.get("/health", (req, res) => {
  res.json({ status: "ok", uptime: process.uptime(), connections: io.engine.clientsCount });
});

const usersInVoice = {}; // { roomId: [{ id, username }] } - kept for real-time WebRTC signaling
const usersInRoom = {}; // { roomId: { socketId: username } } - kept for compatibility
const socketToRoom = {}; // { socketId: roomId } for voice
const socketToTextRoom = {}; // { socketId: roomId } for text
const roomEmptyTimestamps = {}; // { roomId: timestamp } - when room became empty

// --- Persistence Protection ---
const SERVER_START_TIME = Date.now();
const GRACE_PERIOD_MS = 1 * 60 * 1000; // 1 minute grace period on startup (reduced from 5)

// ============================================================================
// DATABASE SESSION MANAGEMENT - The Single Source of Truth
// All user tracking is now persisted in SQLite for reliability
// ============================================================================

// Clean up stale sessions on server start (sessions without heartbeat for 5+ min)
const cleanupStaleSessions = () => {
  try {
    const fiveMinAgo = new Date(Date.now() - 5 * 60 * 1000).toISOString();
    const result = db.prepare("DELETE FROM room_sessions WHERE last_heartbeat < ?").run(fiveMinAgo);
    if (result.changes > 0) {
      console.log(`[Startup] Cleaned up ${result.changes} stale sessions`);
    }
  } catch (err) {
    console.error("[Startup] Error cleaning stale sessions:", err);
  }
};

// Run cleanup AFTER grace period (not immediately on startup)
// This allows clients to reconnect before we delete their sessions
setTimeout(() => {
  console.log("[Startup] Grace period ended, running initial stale session cleanup");
  cleanupStaleSessions();
}, GRACE_PERIOD_MS);

/**
 * Add a session to the database
 */
const addSession = (roomId, socketId, username, sessionType = 'text') => {
  try {
    const now = new Date().toISOString();
    db.prepare(`
      INSERT OR REPLACE INTO room_sessions (room_id, socket_id, username, session_type, joined_at, last_heartbeat)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(roomId, socketId, username, sessionType, now, now);
    console.log(`[Session] Added ${sessionType} session: ${username} in ${roomId}`);
  } catch (err) {
    console.error("[Session] Error adding session:", err);
  }
};

/**
 * Remove a session from the database
 */
const removeSession = (socketId, sessionType = null) => {
  try {
    if (sessionType) {
      db.prepare("DELETE FROM room_sessions WHERE socket_id = ? AND session_type = ?").run(socketId, sessionType);
    } else {
      db.prepare("DELETE FROM room_sessions WHERE socket_id = ?").run(socketId);
    }
    console.log(`[Session] Removed sessions for socket ${socketId}`);
  } catch (err) {
    console.error("[Session] Error removing session:", err);
  }
};

/**
 * Update heartbeat for a socket
 */
const updateHeartbeat = (socketId) => {
  try {
    const now = new Date().toISOString();
    db.prepare("UPDATE room_sessions SET last_heartbeat = ? WHERE socket_id = ?").run(now, socketId);
  } catch (err) {
    console.error("[Session] Error updating heartbeat:", err);
  }
};

/**
 * Get sessions for a room (including voice channels)
 */
const getSessionsForRoom = (roomId) => {
  try {
    // Get sessions for this room AND all voice channels under it
    return db.prepare(`
      SELECT DISTINCT username, session_type FROM room_sessions 
      WHERE room_id = ? OR room_id LIKE ?
    `).all(roomId, `${roomId}-%`);
  } catch (err) {
    console.error("[Session] Error getting sessions:", err);
    return [];
  }
};

// Broadcast all voice room users to all connected clients
const broadcastAllVoiceUsers = () => {
  io.emit("all-rooms-users", usersInVoice);
};

// ============================================================================
// CRITICAL: Room User Count System
// RULE 1: If room has >= 1 user, it MUST stay open FOREVER
// RULE 2: If room has 0 users for 30 seconds, it gets deleted
// These rules are ABSOLUTE and must NEVER be broken by any code changes
// ============================================================================

/**
 * Get the REAL user count for a room by checking the DATABASE
 * This function is the SINGLE SOURCE OF TRUTH for user counts
 */
const getRealUserCount = (roomId) => {
  try {
    // Query database for all sessions in this room and its voice channels
    const sessions = db.prepare(`
      SELECT DISTINCT username FROM room_sessions 
      WHERE room_id = ? OR room_id LIKE ?
    `).all(roomId, `${roomId}-%`);
    
    const usernames = sessions.map(s => s.username);
    
    return {
      count: usernames.length,
      users: usernames
    };
  } catch (err) {
    console.error("[getRealUserCount] Database error:", err);
    
    // Fallback to RAM-based counting if DB fails
    const usernames = new Set();
    
    if (usersInRoom[roomId]) {
      Object.values(usersInRoom[roomId]).forEach(name => {
        if (name) usernames.add(name);
      });
    }
    
    for (const [voiceRoomId, users] of Object.entries(usersInVoice)) {
      if (!users || users.length === 0) continue;
      if (voiceRoomId.startsWith(roomId + '-') || voiceRoomId === roomId) {
        users.forEach(u => {
          if (u && u.username) usernames.add(u.username);
        });
      }
    }
    
    return {
      count: usernames.size,
      users: Array.from(usernames)
    };
  }
};

/**
 * Check if a room should be protected from deletion
 * A room is PROTECTED if it has ANY users
 */
const isRoomProtected = (roomId) => {
  const { count } = getRealUserCount(roomId);
  return count > 0;
};

/**
 * Mark a room as empty (starts the 30 second countdown)
 * Called when last user leaves
 */
const markRoomAsEmpty = (roomId) => {
  // Double-check that room is actually empty
  if (isRoomProtected(roomId)) {
    delete roomEmptyTimestamps[roomId]; // Clear any pending deletion
    return;
  }
  
  if (!roomEmptyTimestamps[roomId]) {
    roomEmptyTimestamps[roomId] = Date.now();
    console.log(`[Room] ${roomId} is now empty, starting 30s countdown`);
  }
};

/**
 * Mark a room as occupied (cancels any pending deletion)
 * Called when any user joins
 */
const markRoomAsOccupied = (roomId) => {
  if (roomEmptyTimestamps[roomId]) {
    delete roomEmptyTimestamps[roomId];
    console.log(`[Room] ${roomId} is now occupied, cancelled deletion`);
  }
};

// Helper to get active users count per room for the rooms API
const getRoomStats = () => {
  const stats = {};
  
  // Get all rooms from database
  try {
    const rooms = db.prepare("SELECT id FROM rooms").all();
    rooms.forEach(room => {
      const { count, users } = getRealUserCount(room.id);
      stats[room.id] = { count, users };
    });
  } catch (e) {
    console.error("Error getting room stats:", e);
  }
  
  return stats;
};

// ============================================================================
// Room Cleanup System - CRITICAL LOGIC
// Runs every 5 seconds for high responsiveness
// ============================================================================
setInterval(() => {
  try {
    const now = Date.now();
    const DELETE_AFTER_MS = 30 * 1000; // STRICT: 30 seconds
    
    // CRITICAL: Only clean up stale sessions AFTER grace period
    if (now - SERVER_START_TIME >= GRACE_PERIOD_MS) {
      const fiveMinAgo = new Date(now - 5 * 60 * 1000).toISOString();
      db.prepare("DELETE FROM room_sessions WHERE last_heartbeat < ?").run(fiveMinAgo);
    }
    
    const rooms = db.prepare("SELECT * FROM rooms").all();

    rooms.forEach(room => {
      const { count } = getRealUserCount(room.id);
      
      // RULE 1: If room has users (even 1), it's PROTECTED - NEVER delete
      if (count > 0) {
        markRoomAsOccupied(room.id);
        return; 
      }
      
      // RULE 2: Room is empty - start/check countdown
      if (!roomEmptyTimestamps[room.id]) {
        markRoomAsEmpty(room.id);
      }
      
      const emptyTime = roomEmptyTimestamps[room.id];
      if (emptyTime && (now - emptyTime >= DELETE_AFTER_MS)) {
        // RULE 3: Server Warmup Protection (1 min)
        if (now - SERVER_START_TIME < GRACE_PERIOD_MS) {
          return;
        }

        // Final safety check
        if (isRoomProtected(room.id)) {
          markRoomAsOccupied(room.id);
          return;
        }
        
        console.log(`[Cleanup] Deleting room: ${room.name} (Empty for 30s)`);
        db.prepare("DELETE FROM rooms WHERE id = ?").run(room.id);
        io.emit("room-deleted", room.id);
        delete roomEmptyTimestamps[room.id];
      }
    });

    // Clean up tracking objects for non-existent rooms to prevent memory leaks
    for (const rid in usersInRoom) {
      if (Object.keys(usersInRoom[rid]).length === 0) delete usersInRoom[rid];
    }
    for (const rid in usersInVoice) {
      if (usersInVoice[rid].length === 0) delete usersInVoice[rid];
    }
  } catch (err) {
    console.error("Cleanup error:", err);
  }
}, 5000); // Check every 5 seconds for precision

io.on("connection", (socket) => {
  console.log("User connected:", socket.id);
  
  // Send current voice users to new connection
  socket.emit("all-rooms-users", usersInVoice);

  // Join a Text/Socket Room
  socket.on("join-room", (data) => {
    const roomId = typeof data === 'object' ? data.roomId : data;
    const username = typeof data === 'object' ? data.username : "Anonymous";

    // Leave previous text room if any
    const previousRoom = socketToTextRoom[socket.id];
    if (previousRoom && previousRoom !== roomId) {
      // Remove from DB
      removeSession(socket.id, 'text');
      
      if (usersInRoom[previousRoom] && usersInRoom[previousRoom][socket.id]) {
        delete usersInRoom[previousRoom][socket.id];
        // Check if previous room is now empty
        if (Object.keys(usersInRoom[previousRoom]).length === 0) {
          markRoomAsEmpty(previousRoom);
        }
      }
      socket.leave(previousRoom);
    }

    socket.join(roomId);
    socketToTextRoom[socket.id] = roomId;
    
    // Track user in room (RAM for compatibility)
    if (!usersInRoom[roomId]) {
      usersInRoom[roomId] = {};
    }
    usersInRoom[roomId][socket.id] = username;
    
    // CRITICAL: Add to database for persistence
    addSession(roomId, socket.id, username, 'text');
    
    // CRITICAL: Mark room as occupied - cancels any pending deletion
    markRoomAsOccupied(roomId);
    
    console.log(`[Join] User ${socket.id} (${username}) joined room ${roomId}`);

    // Send system message only to others (don't spam the joiner)
    socket.to(roomId).emit("message-received", {
      id: Date.now(),
      content: `${username} odaya katildi.`,
      user_id: 0,
      username: "System",
      type: "system",
      room_id: roomId,
      created_at: new Date().toISOString()
    });
  });

  socket.on("send-message", async (data) => {
    const { content, user, type = "text", fileUrl, fileName, roomId = "general" } = data;
    
    // Validate required fields
    if (!content || !user || !user.id || !user.username) {
      console.error("[Message] Invalid message data:", { content: !!content, user: !!user, userId: user?.id, username: user?.username });
      socket.emit("message-error", { error: "Invalid message data" });
      return;
    }
    
    // Ensure user.id is a number
    const userId = Number(user.id);
    if (isNaN(userId)) {
      console.error("[Message] Invalid user ID:", user.id);
      socket.emit("message-error", { error: "Invalid user ID" });
      return;
    }
    
    try {
      if (type === "text" && typeof content === "string" && content.trim().startsWith("/")) {
        const wasHandled = await handleMusicCommand({
          socket,
          roomId,
          user,
          commandText: content.trim()
        });

        if (wasHandled) {
          return;
        }
      }

      const stmt = db.prepare("INSERT INTO messages (content, user_id, username, type, room_id) VALUES (?, ?, ?, ?, ?)");
      const info = stmt.run(content, userId, user.username, type, roomId);
      
      const message = {
        id: Number(info.lastInsertRowid),
        content,
        user_id: userId,
        username: user.username,
        type,
        fileUrl,
        fileName,
        room_id: roomId,
        created_at: new Date().toISOString()
      };

      // Emit to all users in the room
      io.to(roomId).emit("message-received", message);
      console.log(`[Message] Sent to room ${roomId} by ${user.username} (${userId})`);
      
    } catch (err) {
      console.error("[Message] Error saving message:", err);
      socket.emit("message-error", { error: "Failed to save message" });
    }
  });

  socket.on("disconnect", () => {
    console.log("User disconnected:", socket.id);
    
    // CRITICAL: Remove ALL sessions for this socket from database
    removeSession(socket.id);
    
    // Remove from text room (RAM)
    const textRoomId = socketToTextRoom[socket.id];
    if (textRoomId && usersInRoom[textRoomId] && usersInRoom[textRoomId][socket.id]) {
      delete usersInRoom[textRoomId][socket.id];
      // Check if room is now empty
      if (Object.keys(usersInRoom[textRoomId]).length === 0) {
        markRoomAsEmpty(textRoomId);
      }
    }
    delete socketToTextRoom[socket.id];

    // Remove user from voice list (RAM for WebRTC signaling)
    const roomID = socketToRoom[socket.id];
    let room = usersInVoice[roomID];
    if (room) {
      room = room.filter(u => u.id !== socket.id);
      usersInVoice[roomID] = room;
      socket.broadcast.to(roomID).emit('user-left-voice', socket.id);
      broadcastAllVoiceUsers();

      const session = musicSessions.get(roomID);
      if (session) {
        destroyMusicPeer(session, socket.id);
      }

      maybeAutoStopMusicForRoom(roomID);
      
      // Check if voice room's server is now empty
      if (room.length === 0 && roomID) {
        const lastDash = roomID.lastIndexOf('-');
        if (lastDash > 0) {
          const serverId = roomID.substring(0, lastDash);
          if (!isRoomProtected(serverId)) {
            markRoomAsEmpty(serverId);
          }
        }
      }
    }
    delete socketToRoom[socket.id];
  });

  socket.on("join-voice", (data) => {
    const roomId = typeof data === 'object' ? data.roomId : data;
    const userData = typeof data === 'object' ? data.user : { username: "Unknown" };

    console.log(`User ${socket.id} (${userData.username}) joining voice in ${roomId}`);
    
    // Add to voice list (RAM for WebRTC signaling)
    if (!usersInVoice[roomId]) {
      usersInVoice[roomId] = [];
    }
    
    // Check if user is already in (prevent duplicates)
    const existingIndex = usersInVoice[roomId].findIndex(u => u.id === socket.id);
    if (existingIndex !== -1) {
      usersInVoice[roomId][existingIndex] = { id: socket.id, username: userData.username };
    } else {
      usersInVoice[roomId].push({ id: socket.id, username: userData.username });
    }
    
    socketToRoom[socket.id] = roomId;
    
    // Join socket room for signaling
    socket.join(roomId);
    
    // CRITICAL: Add voice session to database
    addSession(roomId, socket.id, userData.username, 'voice');
    
    // CRITICAL: Mark the server as occupied
    // Voice room format: "serverid-channelname"
    const lastDash = roomId.lastIndexOf('-');
    if (lastDash > 0) {
      const serverId = roomId.substring(0, lastDash);
      markRoomAsOccupied(serverId);
    }

    // Send existing users to the new joiner
    const usersInThisRoom = usersInVoice[roomId].filter(u => u.id !== socket.id && !isMusicBotId(u.id));
    socket.emit("all-voice-users", usersInThisRoom);

    // If music bot is active in this room, connect it to the newly joined user.
    if (musicSessions.has(roomId)) {
      connectBotToUser(roomId, socket.id);
    }
    
    // Broadcast updated room list to everyone
    broadcastAllVoiceUsers();
  });

  socket.on("sending-signal", (payload) => {
    // Fallback: if client ever tries to signal directly to the music bot id,
    // handle it server-side as an answerer peer.
    if (isMusicBotId(payload.userToSignal)) {
      const voiceRoomId = socketToRoom[socket.id];
      const session = musicSessions.get(voiceRoomId);
      if (!session) return;

      const RTC = wrtc.default || wrtc;
      let peer = session.peers.get(socket.id);

      if (!peer) {
        peer = new Peer({
          initiator: false,
          trickle: false,
          stream: session.stream,
          wrtc: RTC,
          config: {
            iceServers: [
              { urls: "stun:stun.l.google.com:19302" },
              { urls: "stun:global.stun.twilio.com:3478" }
            ]
          }
        });

        peer.on("signal", (signal) => {
          io.to(socket.id).emit("receiving-returned-signal", { signal, id: session.botId });
        });

        peer.on("error", (err) => {
          console.error("[MusicBot] Fallback peer error:", err.message);
          destroyMusicPeer(session, socket.id);
        });

        peer.on("close", () => {
          destroyMusicPeer(session, socket.id);
        });

        session.peers.set(socket.id, peer);
      }

      peer.signal(payload.signal);
      return;
    }

    io.to(payload.userToSignal).emit("user-joined-voice", {
      signal: payload.signal,
      callerID: payload.callerID,
      username: payload.username
    });
  });

  socket.on("returning-signal", (payload) => {
    if (isMusicBotId(payload.callerID)) {
      const voiceRoomId = socketToRoom[socket.id];
      const session = musicSessions.get(voiceRoomId);
      if (!session) return;

      const peer = session.peers.get(socket.id);
      if (peer) {
        peer.signal(payload.signal);
      }
      return;
    }

    io.to(payload.callerID).emit("receiving-returned-signal", { signal: payload.signal, id: socket.id });
  });

  socket.on("leave-voice", () => {
    const roomID = socketToRoom[socket.id];
    
    // CRITICAL: Remove voice session from database
    removeSession(socket.id, 'voice');
    
    let room = usersInVoice[roomID];
    if (room) {
      room = room.filter(u => u.id !== socket.id);
      usersInVoice[roomID] = room;
      socket.broadcast.to(roomID).emit('user-left-voice', socket.id);
      broadcastAllVoiceUsers();

      const session = musicSessions.get(roomID);
      if (session) {
        destroyMusicPeer(session, socket.id);
      }

      maybeAutoStopMusicForRoom(roomID);
      
      // Check if voice room's server is now empty
      if (room.length === 0 && roomID) {
        const lastDash = roomID.lastIndexOf('-');
        if (lastDash > 0) {
          const serverId = roomID.substring(0, lastDash);
          if (!isRoomProtected(serverId)) {
            markRoomAsEmpty(serverId);
          }
        }
      }
    }
    if (roomID) socket.leave(roomID);
    delete socketToRoom[socket.id];
  });

  // Heartbeat handler - client sends this every 30 seconds
  socket.on("heartbeat", (data) => {
    updateHeartbeat(socket.id);
  });

});

httpServer.listen(port, () => {
  console.log(`Server running on port ${port}`);
});
