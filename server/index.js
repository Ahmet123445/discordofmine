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
import { createHash, randomUUID } from "crypto";
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

const FRAME_SIZE_BYTES = 3840;
const FRAME_DURATION_MS = 20;
const MUSIC_PREBUFFER_FRAMES = Number(process.env.MUSIC_PREBUFFER_FRAMES || 36);
const MUSIC_REBUFFER_FRAMES = Number(process.env.MUSIC_REBUFFER_FRAMES || 20);
const MUSIC_PREFETCH_TRACKS = Number(process.env.MUSIC_PREFETCH_TRACKS || 2);
const MUSIC_PREFETCH_WAIT_TIMEOUT_MS = Number(process.env.MUSIC_PREFETCH_WAIT_TIMEOUT_MS || 2500);
const MUSIC_CURRENT_PREFETCH_WAIT_TIMEOUT_MS = Number(process.env.MUSIC_CURRENT_PREFETCH_WAIT_TIMEOUT_MS || 25000);
const MUSIC_STATE_EMIT_INTERVAL_MS = Number(process.env.MUSIC_STATE_EMIT_INTERVAL_MS || 1000);
const MUSIC_CONTROL_COOLDOWN_MS = Number(process.env.MUSIC_CONTROL_COOLDOWN_MS || 140);
const MUSIC_PREFERRED_AUDIO_EXT = (process.env.MUSIC_PREFERRED_AUDIO_EXT || "mp3").toLowerCase();
const MUSIC_BOT_USERNAME = "Music Bot";
const musicSessions = new Map();
const resolvedTrackCache = new Map();
const prefetchInFlightByCacheKey = new Map();
const TRACK_CACHE_TTL_MS = 10 * 60 * 1000;
const ytDlpBinary = process.env.YTDLP_PATH || "yt-dlp";
const ytDlpCookiesPath = process.env.YTDLP_COOKIES_PATH || path.join(process.cwd(), "yt-cookies.txt");
const musicCacheDir = process.env.MUSIC_CACHE_DIR || path.join(process.cwd(), "music-cache");
const MUSIC_CACHE_TTL_MS = Number(process.env.MUSIC_CACHE_TTL_MS || 24 * 60 * 60 * 1000);
const MUSIC_CACHE_MAX_FILES = Number(process.env.MUSIC_CACHE_MAX_FILES || 120);
const MUSIC_CACHE_MAX_BYTES = Number(process.env.MUSIC_CACHE_MAX_BYTES || 2 * 1024 * 1024 * 1024);
const hasYtDlpCookies = () => fs.existsSync(ytDlpCookiesPath);
const SILENCE_SAMPLES = new Int16Array(FRAME_SIZE_BYTES / 2);

fs.mkdirSync(musicCacheDir, { recursive: true });

const pruneMusicCacheDirectory = () => {
  try {
    const now = Date.now();
    const protectedCachePaths = new Set();

    for (const session of musicSessions.values()) {
      const tracks = [session.current, ...(session.queue || [])].filter(Boolean);
      for (const track of tracks) {
        const cachedPath = track?.prefetchFilePath;
        if (cachedPath && fs.existsSync(cachedPath)) {
          protectedCachePaths.add(cachedPath);
        }
      }
    }

    const files = fs.readdirSync(musicCacheDir)
      .map((name) => {
        const fullPath = path.join(musicCacheDir, name);
        const stat = fs.statSync(fullPath);
        if (!stat.isFile()) {
          return null;
        }
        return {
          fullPath,
          mtimeMs: stat.mtimeMs,
          size: stat.size,
          ageMs: now - stat.mtimeMs
        };
      })
      .filter((item) => item && Number.isFinite(item.size));

    for (const item of files) {
      if (item.ageMs <= MUSIC_CACHE_TTL_MS) continue;
      if (protectedCachePaths.has(item.fullPath)) continue;
      try {
        fs.unlinkSync(item.fullPath);
      } catch {}
    }

    const freshFiles = fs.readdirSync(musicCacheDir)
      .map((name) => {
        const fullPath = path.join(musicCacheDir, name);
        const stat = fs.statSync(fullPath);
        if (!stat.isFile()) {
          return null;
        }
        return {
          fullPath,
          mtimeMs: stat.mtimeMs,
          size: stat.size
        };
      })
      .filter(Boolean)
      .sort((a, b) => a.mtimeMs - b.mtimeMs);

    let totalBytes = freshFiles.reduce((sum, file) => sum + file.size, 0);
    for (let i = 0; i < freshFiles.length; i++) {
      if (protectedCachePaths.has(freshFiles[i].fullPath)) continue;
      const overFileLimit = i >= MUSIC_CACHE_MAX_FILES;
      const overSizeLimit = totalBytes > MUSIC_CACHE_MAX_BYTES;
      if (!overFileLimit && !overSizeLimit) break;
      try {
        fs.unlinkSync(freshFiles[i].fullPath);
        totalBytes -= freshFiles[i].size;
      } catch {}
    }
  } catch (err) {
    console.error("[MusicBot] Cache prune failed:", err.message);
  }
};

pruneMusicCacheDirectory();

const DEFAULT_ICE_SERVERS = [
  { urls: "stun:stun.l.google.com:19302" },
  { urls: "stun:global.stun.twilio.com:3478" }
];

const parseIceServers = () => {
  const custom = (process.env.ICE_SERVERS_JSON || "").trim();
  if (custom) {
    try {
      const parsed = JSON.parse(custom);
      if (Array.isArray(parsed) && parsed.length > 0) {
        return parsed;
      }
    } catch (err) {
      console.error("[Voice] ICE_SERVERS_JSON parse hatasi:", err.message);
    }
  }

  const turnUrls = (process.env.TURN_URL || "").split(",").map((item) => item.trim()).filter(Boolean);
  if (turnUrls.length > 0) {
    const username = process.env.TURN_USERNAME || "";
    const credential = process.env.TURN_PASSWORD || "";

    return [
      ...DEFAULT_ICE_SERVERS,
      ...turnUrls.map((urls) => ({ urls, username, credential }))
    ];
  }

  return DEFAULT_ICE_SERVERS;
};

const ICE_SERVERS = parseIceServers();

const getYtDlpBaseArgs = () => {
  const args = [
    "--no-warnings",
    "--user-agent",
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
    "--add-header",
    "Accept:text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    "--add-header",
    "Accept-Language:en-us,en;q=0.5",
    "--add-header",
    "Sec-Fetch-Mode:navigate",
    "--js-runtimes",
    "node",
    "--remote-components",
    "ejs:github",
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
const getServerRoomIdFromVoiceRoomId = (voiceRoomId = "") => {
  const lastDash = voiceRoomId.lastIndexOf("-");
  return lastDash > 0 ? voiceRoomId.substring(0, lastDash) : "";
};

const extractYouTubeVideoId = (value = "") => {
  const trimmed = String(value || "").trim();
  if (!trimmed) return "";

  if (/^[A-Za-z0-9_-]{11}$/.test(trimmed)) {
    return trimmed;
  }

  try {
    const parsed = new URL(trimmed);
    const host = parsed.hostname.toLowerCase();
    const vParam = parsed.searchParams.get("v");
    if (vParam && /^[A-Za-z0-9_-]{11}$/.test(vParam)) {
      return vParam;
    }

    if (host.includes("youtu.be")) {
      const shortId = parsed.pathname.replace(/^\//, "").split("/")[0];
      if (/^[A-Za-z0-9_-]{11}$/.test(shortId)) {
        return shortId;
      }
    }

    const parts = parsed.pathname.split("/").filter(Boolean);
    const watchId = parts.length > 1 && ["shorts", "embed", "live"].includes(parts[0]) ? parts[1] : "";
    if (/^[A-Za-z0-9_-]{11}$/.test(watchId)) {
      return watchId;
    }
  } catch {}

  return "";
};

const buildTrackCacheKey = (track = {}) => {
  const sourceId = extractYouTubeVideoId(track.sourceId || track.url || "");
  if (sourceId) {
    return `yt-${sourceId}`;
  }

  const normalizedUrl = String(track.url || "").trim().toLowerCase();
  if (normalizedUrl) {
    const hash = createHash("sha1").update(normalizedUrl).digest("hex").slice(0, 16);
    return `url-${hash}`;
  }

  const normalizedTitle = String(track.title || "unknown-track").trim().toLowerCase();
  const hash = createHash("sha1").update(normalizedTitle).digest("hex").slice(0, 16);
  return `title-${hash}`;
};

const getTrackCacheKey = (track) => {
  if (!track) return "";
  if (!track.cacheKey) {
    track.cacheKey = buildTrackCacheKey(track);
  }
  return track.cacheKey;
};

const buildLocalPlaybackFfmpegArgs = ({ filePath, volume = 80, seekSec = null }) => {
  const args = [
    "-loglevel", "error"
  ];

  if (typeof seekSec === "number" && seekSec > 0) {
    args.push("-ss", `${seekSec}`);
  }

  args.push(
    "-i", filePath,
    "-vn",
    "-sn",
    "-dn",
    "-filter:a", `volume=${Math.max(0, volume) / 100}`,
    "-f", "s16le",
    "-ar", "48000",
    "-ac", "2",
    "pipe:1"
  );

  return args;
};

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

const saveAndBroadcastMessage = ({ content, userId, username, type = "text", roomId = "general", fileUrl, fileName }) => {
  const stmt = db.prepare("INSERT INTO messages (content, user_id, username, type, room_id) VALUES (?, ?, ?, ?, ?)");
  const info = stmt.run(content, userId, username, type, roomId);

  const message = {
    id: Number(info.lastInsertRowid),
    content,
    user_id: userId,
    username,
    type,
    fileUrl,
    fileName,
    room_id: roomId,
    created_at: new Date().toISOString()
  };

  io.to(roomId).emit("message-received", message);
  console.log(`[Message] Sent to room ${roomId} by ${username} (${userId})`);

  return message;
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

const stopPlaybackTimer = (session) => {
  if (!session.playbackInterval) return;

  clearInterval(session.playbackInterval);
  session.playbackInterval = null;
};

const resetPlaybackState = (session) => {
  stopPlaybackTimer(session);
  session.audioChunks = [];
  session.bufferedBytes = 0;
  session.hasPlaybackStarted = false;
  session.hasAnnouncedPlaybackStart = false;
  session.isRebuffering = false;
  session.sourceEnded = false;
  session.sentSilenceFrames = 0;
  session.playedFrames = 0;
  session.seekOffsetSec = 0;
  session.currentPositionSec = 0;
};

const stopCurrentPlayback = (session) => {
  session.activePlaybackToken += 1;

  if (!session.ffmpegProcess && !session.sourceProcess) {
    resetPlaybackState(session);
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
  resetPlaybackState(session);
  session.current = null;
  session.isPlaying = false;
  session.isPaused = false;
};

const closeMusicSession = (voiceRoomId, reason = null) => {
  const session = musicSessions.get(voiceRoomId);
  if (!session) return;

  const serverRoomId = getServerRoomIdFromVoiceRoomId(voiceRoomId);
  const activeTrack = session.current;
  stopCurrentPlayback(session);
  destroyAllMusicPeers(session);

  try {
    session.track.stop();
  } catch {}

  disposeTrack(activeTrack);
  session.queue.forEach((track) => disposeTrack(track));
  session.queue = [];
  session.current = null;
  session.currentPositionSec = 0;
  emitMusicState(session, true);
  musicSessions.delete(voiceRoomId);
  removeMusicBotPresence(voiceRoomId);

  if (reason) {
    sendSystemMessage(serverRoomId, reason);
  }
};

const getCachedValue = (cache, key) => {
  const entry = cache.get(key);
  if (!entry) return null;
  if (entry.expiresAt <= Date.now()) {
    cache.delete(key);
    return null;
  }
  return entry.value;
};

const setCachedValue = (cache, key, value, ttlMs) => {
  cache.set(key, {
    value,
    expiresAt: Date.now() + ttlMs
  });
};

const createQueuedTrack = (track, requestedBy) => {
  return {
    id: randomUUID(),
    ...track,
    sourceId: track.sourceId || null,
    cacheKey: buildTrackCacheKey(track),
    requestedBy,
    prefetchStatus: "queued",
    prefetchFilePath: null,
    prefetchProcess: null,
    prefetchPromise: null,
    prefetchError: null
  };
};

const getPrefetchOutputTemplate = (track) => {
  const cacheKey = getTrackCacheKey(track) || track.id;
  return path.join(musicCacheDir, `${cacheKey}.%(ext)s`);
};

const isAcceptedPrefetchFile = (filePath = "") => {
  if (!filePath) return false;
  const ext = path.extname(filePath).replace(".", "").toLowerCase();
  if (!ext) return false;
  if (MUSIC_PREFERRED_AUDIO_EXT === "mp3") {
    return ext === "mp3";
  }
  return true;
};

const findPrefetchedFilePath = (track) => {
  try {
    const prefix = `${getTrackCacheKey(track) || track.id}.`;
    const fileName = fs.readdirSync(musicCacheDir)
      .filter((name) => name.startsWith(prefix))
      .sort((a, b) => {
        const aIsPreferred = a.toLowerCase().endsWith(`.${MUSIC_PREFERRED_AUDIO_EXT}`);
        const bIsPreferred = b.toLowerCase().endsWith(`.${MUSIC_PREFERRED_AUDIO_EXT}`);
        if (aIsPreferred === bIsPreferred) return 0;
        return aIsPreferred ? -1 : 1;
      })
      .find((name) => isAcceptedPrefetchFile(path.join(musicCacheDir, name)));
    return fileName ? path.join(musicCacheDir, fileName) : null;
  } catch {
    return null;
  }
};

const getExistingPrefetchFilePath = (track) => {
  if (track?.prefetchFilePath && fs.existsSync(track.prefetchFilePath) && isAcceptedPrefetchFile(track.prefetchFilePath)) {
    return track.prefetchFilePath;
  }

  const discoveredPath = findPrefetchedFilePath(track);
  if (discoveredPath) {
    track.prefetchFilePath = discoveredPath;
    track.prefetchStatus = "prefetched";
    return discoveredPath;
  }

  track.prefetchFilePath = null;
  if (track?.prefetchStatus === "prefetched") {
    track.prefetchStatus = "queued";
  }
  return null;
};

const cleanupTrackFile = (track) => {
  if (!track) return;

  const filePath = track.prefetchFilePath || findPrefetchedFilePath(track);
  if (filePath && fs.existsSync(filePath)) {
    try {
      fs.unlinkSync(filePath);
    } catch (err) {
      console.error(`[MusicBot] Failed to remove cached track ${filePath}:`, err.message);
    }
  }

  if (track) {
    track.prefetchFilePath = null;
  }
};

const cancelTrackPrefetch = (track, resetStatus = true) => {
  if (!track) return;

  const hadRunningProcess = !!track.prefetchProcess;

  try {
    track.prefetchProcess?.stdout?.removeAllListeners();
    track.prefetchProcess?.stderr?.removeAllListeners();
  } catch {}

  try {
    track.prefetchProcess?.kill("SIGKILL");
  } catch {}

  track.prefetchProcess = null;
  track.prefetchPromise = null;
  if (hadRunningProcess) {
    cleanupTrackFile(track);
  }
  track.prefetchError = null;

  if (resetStatus) {
    track.prefetchStatus = "queued";
  }
};

const disposeTrack = (track) => {
  if (!track) return;
  cancelTrackPrefetch(track, false);
  track.prefetchStatus = "done";
};

const runYtDlpJson = (input, extraArgs = []) => {
  return new Promise((resolve, reject) => {
    const args = [...getYtDlpBaseArgs(), ...extraArgs, "--skip-download", "--dump-single-json", input];
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

const normalizeYtDlpTrack = (entry) => {
  const videoId = entry.id || entry.url;
  const webpageUrl = entry.webpage_url || entry.url || (videoId ? `https://www.youtube.com/watch?v=${videoId}` : null);
  const sourceId = extractYouTubeVideoId(entry.id || webpageUrl || "");

  return {
    title: entry.title || "Bilinmeyen Sarki",
    url: webpageUrl,
    durationInSec: Number(entry.duration || 0),
    thumbnail: entry.thumbnail || null,
    sourceId: sourceId || null,
    cacheKey: buildTrackCacheKey({ sourceId, url: webpageUrl, title: entry.title })
  };
};

const searchYouTubeIdsByHtml = async (query, limit = 20) => {
  const encoded = encodeURIComponent(query);
  const response = await fetch(`https://www.youtube.com/results?search_query=${encoded}`, {
    headers: {
      "user-agent": "Mozilla/5.0"
    }
  });

  if (!response.ok) {
    throw new Error("YouTube arama sayfasi acilamadi.");
  }

  const html = await response.text();
  const ids = [];
  const seen = new Set();
  const regex = /\"videoId\":\"([A-Za-z0-9_-]{11})\"/g;
  let match = null;

  while ((match = regex.exec(html)) !== null) {
    const id = match[1];
    if (!seen.has(id)) {
      seen.add(id);
      ids.push(id);
      if (ids.length >= limit) break;
    }
  }

  return ids;
};

const normalizeYtDlpTrackEntries = (result, limit = 5) => {
  const entries = Array.isArray(result?.entries)
    ? result.entries.filter(Boolean)
    : (result ? [result] : []);

  return entries.slice(0, limit).map(normalizeYtDlpTrack).filter((item) => !!item.url);
};

const searchTracksWithYtDlp = async (query, limit = 5) => {
  const searchQuery = `ytsearch${Math.max(limit, 1)}:${query}`;
  const result = await runYtDlpJson(searchQuery, ["--flat-playlist"]);
  return normalizeYtDlpTrackEntries(result, limit);
};

const getPlayableTracksFromSearch = async (query, limit = 5) => {
  const trimmed = (query || "").trim();
  if (!trimmed) return [];

  // Primary strategy: yt-dlp's native search (more reliable than HTML scraping).
  try {
    const directTracks = await searchTracksWithYtDlp(trimmed, limit);
    if (directTracks.length > 0) {
      return directTracks;
    }
  } catch {}

  // Fallback strategy: scrape ids from YouTube search HTML, then resolve each id.
  const ids = await searchYouTubeIdsByHtml(trimmed, Math.max(limit * 4, 20));
  const tracks = [];

  for (const id of ids) {
    const url = `https://www.youtube.com/watch?v=${id}`;
    try {
      const result = await runYtDlpJson(url);
      const entry = Array.isArray(result.entries) ? result.entries.find(Boolean) : result;
      if (entry) {
        tracks.push(normalizeYtDlpTrack(entry));
      }
      if (tracks.length >= limit) break;
    } catch {}
  }

  return tracks;
};

const resolveTrack = async (query) => {
  const trimmed = (query || "").trim();
  if (!trimmed) {
    throw new Error("Arama sorgusu bos olamaz.");
  }

  const cachedTrack = getCachedValue(resolvedTrackCache, trimmed.toLowerCase());
  if (cachedTrack) {
    return cachedTrack;
  }

  const isUrl = /^https?:\/\//i.test(trimmed);
  if (isUrl) {
    const result = await runYtDlpJson(trimmed);
    const entry = Array.isArray(result.entries) ? result.entries.find(Boolean) : result;
    if (!entry) {
      throw new Error("Verilen link cozumlenemedi.");
    }
    const normalizedTrack = normalizeYtDlpTrack(entry);
    setCachedValue(resolvedTrackCache, trimmed.toLowerCase(), normalizedTrack, TRACK_CACHE_TTL_MS);
    return normalizedTrack;
  }

  const results = await getPlayableTracksFromSearch(trimmed, 3);
  if (!results || results.length === 0) {
    throw new Error("Arama sonucu bulunamadi.");
  }

  setCachedValue(resolvedTrackCache, trimmed.toLowerCase(), results[0], TRACK_CACHE_TTL_MS);
  return results[0];
};

const searchTracks = async (query, limit = 5) => {
  return getPlayableTracksFromSearch(query, limit);
};

const prefetchTrack = (track) => {
  const existingFilePath = getExistingPrefetchFilePath(track);
  if (existingFilePath) {
    track.prefetchFilePath = existingFilePath;
    track.prefetchStatus = "prefetched";
    return Promise.resolve(track);
  }

  if (track.prefetchPromise) {
    return track.prefetchPromise;
  }

  const cacheKey = getTrackCacheKey(track);
  const sharedPrefetch = prefetchInFlightByCacheKey.get(cacheKey);
  if (sharedPrefetch) {
    track.prefetchStatus = "prefetching";
    track.prefetchError = null;
    track.prefetchPromise = sharedPrefetch
      .then((filePath) => {
        track.prefetchFilePath = filePath;
        track.prefetchStatus = "prefetched";
        track.prefetchError = null;
        return track;
      })
      .catch((err) => {
        track.prefetchStatus = "failed";
        track.prefetchError = err.message;
        throw err;
      })
      .finally(() => {
        track.prefetchPromise = null;
        track.prefetchProcess = null;
      });

    return track.prefetchPromise;
  }

  track.prefetchStatus = "prefetching";
  track.prefetchError = null;

  const ytDlpArgs = [
    ...getYtDlpBaseArgs(),
    "--no-playlist",
    "--no-progress",
    "--newline",
    "--buffer-size", "64K",
    "--http-chunk-size", "1M",
    "--socket-timeout", "15",
    "-f",
    "bestaudio/best",
    "--extract-audio",
    "--audio-format", "mp3",
    "--audio-quality", "192K",
    "--prefer-ffmpeg",
    "-o",
    getPrefetchOutputTemplate(track),
    "--print",
    "after_move:filepath",
    track.url
  ];

  const proc = spawn(ytDlpBinary, ytDlpArgs, {
    stdio: ["ignore", "pipe", "pipe"]
  });

  track.prefetchProcess = proc;

  let stdout = "";
  let stderr = "";

  const sharedPromise = new Promise((resolve, reject) => {
    proc.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });

    proc.stderr.on("data", (chunk) => {
      const msg = chunk.toString().trim();
      if (!msg) return;
      stderr += `${msg}\n`;
      console.error(`[MusicBot][prefetch:${track.title}]`, msg);
    });

    proc.on("error", (err) => {
      track.prefetchProcess = null;
      track.prefetchStatus = "failed";
      track.prefetchError = err.message;
      reject(err);
    });

    proc.on("close", (code) => {
      track.prefetchProcess = null;

      const printedPath = stdout
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean)
        .pop();

      const filePath = printedPath && fs.existsSync(printedPath) && isAcceptedPrefetchFile(printedPath)
        ? printedPath
        : findPrefetchedFilePath(track);

      if (code === 0 && filePath) {
        resolve(filePath);
        return;
      }

      cleanupTrackFile(track);
      reject(new Error(stderr.trim() || `yt-dlp prefetch ${code} koduyla sonlandi.`));
    });
  }).finally(() => {
    if (prefetchInFlightByCacheKey.get(cacheKey) === sharedPromise) {
      prefetchInFlightByCacheKey.delete(cacheKey);
    }
  });

  prefetchInFlightByCacheKey.set(cacheKey, sharedPromise);

  const promise = sharedPromise
    .then((filePath) => {
      track.prefetchFilePath = filePath;
      track.prefetchStatus = "prefetched";
      track.prefetchError = null;
      pruneMusicCacheDirectory();
      return track;
    })
    .catch((err) => {
      track.prefetchStatus = "failed";
      track.prefetchError = err.message;
      throw err;
    })
    .finally(() => {
    track.prefetchPromise = null;
    track.prefetchProcess = null;
  });

  track.prefetchPromise = promise;
  return promise;
};

const waitForPrefetchIfNeeded = async (track, timeoutMs = MUSIC_PREFETCH_WAIT_TIMEOUT_MS) => {
  if (!track) return false;
  if (getExistingPrefetchFilePath(track)) return true;
  if (!track.prefetchPromise) return false;

  let timeoutHandle = null;

  try {
    await Promise.race([
      track.prefetchPromise.catch(() => false),
      new Promise((resolve) => {
        timeoutHandle = setTimeout(resolve, timeoutMs);
      })
    ]);
  } finally {
    if (timeoutHandle) {
      clearTimeout(timeoutHandle);
    }
  }

  return !!getExistingPrefetchFilePath(track);
};

const schedulePrefetchForSession = async (session) => {
  if (!session) return;

  if (session.prefetchSyncRunning) {
    session.prefetchSyncQueued = true;
    return;
  }

  session.prefetchSyncRunning = true;

  try {
    for (const track of session.queue.slice(0, MUSIC_PREFETCH_TRACKS)) {
      if (track.prefetchStatus === "prefetched" && getExistingPrefetchFilePath(track)) {
        continue;
      }

      if (track.prefetchStatus === "prefetching") {
        continue;
      }

      try {
        await prefetchTrack(track);
      } catch (err) {
        console.error(`[MusicBot] Prefetch failed for ${track.title}:`, err.message);
      }
    }
  } finally {
    session.prefetchSyncRunning = false;

    if (session.prefetchSyncQueued) {
      session.prefetchSyncQueued = false;
      void schedulePrefetchForSession(session);
    }
  }
};

const serializeTrackForClient = (track) => {
  if (!track) return null;

  return {
    id: track.id,
    title: track.title,
    url: track.url,
    durationInSec: Number(track.durationInSec || 0),
    thumbnail: track.thumbnail || null,
    requestedBy: track.requestedBy || null,
    prefetchStatus: track.prefetchStatus || "queued"
  };
};

const buildMusicStatePayload = (session) => {
  return {
    voiceRoomId: session.voiceRoomId,
    roomId: getServerRoomIdFromVoiceRoomId(session.voiceRoomId),
    isPlaying: !!session.isPlaying,
    isPaused: !!session.isPaused,
    volume: Number(session.volume || 0),
    positionSec: Number(session.currentPositionSec || 0),
    current: serializeTrackForClient(session.current),
    queue: session.queue.map(serializeTrackForClient).filter(Boolean)
  };
};

const buildEmptyMusicStatePayload = (roomId) => ({
  roomId,
  voiceRoomId: null,
  isPlaying: false,
  isPaused: false,
  volume: 80,
  positionSec: 0,
  current: null,
  queue: []
});

const emitMusicState = (session, force = false) => {
  if (!session) return;

  const now = Date.now();
  if (!force && now - (session.lastMusicStateEmitAt || 0) < MUSIC_STATE_EMIT_INTERVAL_MS) {
    return;
  }

  session.lastMusicStateEmitAt = now;
  const roomId = getServerRoomIdFromVoiceRoomId(session.voiceRoomId);
  if (!roomId) return;
  io.to(roomId).emit("music-state", buildMusicStatePayload(session));
};

const findMusicSessionByServerRoomId = (roomId) => {
  for (const session of musicSessions.values()) {
    if (getServerRoomIdFromVoiceRoomId(session.voiceRoomId) === roomId) {
      return session;
    }
  }

  return null;
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
    audioChunks: [],
    bufferedBytes: 0,
    playbackInterval: null,
    hasPlaybackStarted: false,
    hasAnnouncedPlaybackStart: false,
    isRebuffering: false,
    sourceEnded: false,
    sentSilenceFrames: 0,
    playedFrames: 0,
    seekOffsetSec: 0,
    currentPositionSec: 0,
    prefetchSyncRunning: false,
    prefetchSyncQueued: false,
    lastMusicStateEmitAt: 0,
    activePlaybackToken: 0,
    controlActionInFlight: false,
    lastControlActionAt: 0
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
    trickle: true,
    stream: session.stream,
    wrtc: RTC,
    config: {
      iceServers: ICE_SERVERS
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
  if (!chunk || chunk.length === 0) return;
  session.audioChunks.push(chunk);
  session.bufferedBytes += chunk.length;

  if (!session.hasPlaybackStarted) {
    const minimumBytes = FRAME_SIZE_BYTES * MUSIC_PREBUFFER_FRAMES;
    if (session.bufferedBytes >= minimumBytes || session.sourceEnded) {
      session.hasPlaybackStarted = true;
    }
  }

  session.sentSilenceFrames = 0;
};

const pushSilenceFrame = (session) => {
  session.audioSource.onData({
    samples: SILENCE_SAMPLES,
    sampleRate: 48000,
    bitsPerSample: 16,
    channelCount: 2,
    numberOfFrames: FRAME_SIZE_BYTES / 4
  });
};

const flushBufferedFrameToRtcSource = (session) => {
  while (session.bufferedBytes >= FRAME_SIZE_BYTES) {
    const frameData = Buffer.allocUnsafe(FRAME_SIZE_BYTES);
    let written = 0;

    while (written < FRAME_SIZE_BYTES && session.audioChunks.length > 0) {
      const head = session.audioChunks[0];
      const toCopy = Math.min(head.length, FRAME_SIZE_BYTES - written);
      head.copy(frameData, written, 0, toCopy);
      written += toCopy;

      if (toCopy === head.length) {
        session.audioChunks.shift();
      } else {
        session.audioChunks[0] = head.subarray(toCopy);
      }
    }

    session.bufferedBytes = Math.max(0, session.bufferedBytes - FRAME_SIZE_BYTES);

    if (written < FRAME_SIZE_BYTES) {
      session.audioChunks = [];
      session.bufferedBytes = 0;
      return false;
    }

    let samples;
    if (frameData.byteOffset % 2 === 0) {
      samples = new Int16Array(frameData.buffer, frameData.byteOffset, FRAME_SIZE_BYTES / 2);
    } else {
      const arrayBuffer = new ArrayBuffer(FRAME_SIZE_BYTES);
      const view = new Uint8Array(arrayBuffer);
      view.set(frameData);
      samples = new Int16Array(arrayBuffer);
    }

    session.audioSource.onData({
      samples,
      sampleRate: 48000,
      bitsPerSample: 16,
      channelCount: 2,
      numberOfFrames: FRAME_SIZE_BYTES / 4
    });

    session.playedFrames += 1;
    session.currentPositionSec = session.seekOffsetSec + (session.playedFrames * FRAME_DURATION_MS) / 1000;
    if (session.current?.durationInSec > 0) {
      session.currentPositionSec = Math.min(session.currentPositionSec, session.current.durationInSec);
    }

    return true;
  }

  return false;
};

const startPlaybackTimer = (session) => {
  stopPlaybackTimer(session);

  session.playbackInterval = setInterval(() => {
    if (!session.isPlaying || session.isPaused) return;
    if (!session.hasPlaybackStarted) return;

    if (session.isRebuffering) {
      const minimumBytes = FRAME_SIZE_BYTES * MUSIC_REBUFFER_FRAMES;
      if (session.bufferedBytes < minimumBytes && !session.sourceEnded) {
        return;
      }
      session.isRebuffering = false;
    }

    const flushed = flushBufferedFrameToRtcSource(session);
    if (flushed) {
      if (!session.hasAnnouncedPlaybackStart && session.current) {
        const serverRoomId = getServerRoomIdFromVoiceRoomId(session.voiceRoomId);
        sendSystemMessage(serverRoomId, `Caliniyor: ${session.current.title}`);
        session.hasAnnouncedPlaybackStart = true;
        emitMusicState(session, true);
      }

      session.sentSilenceFrames = 0;
      emitMusicState(session, false);
      return;
    }

    if (!session.sourceEnded) {
      session.sentSilenceFrames += 1;

      if (session.sentSilenceFrames >= 2) {
        session.sentSilenceFrames = 0;
        session.isRebuffering = true;
        return;
      }

      pushSilenceFrame(session);
      return;
    }

    stopPlaybackTimer(session);
    emitMusicState(session, true);
  }, FRAME_DURATION_MS);
};

const playNextInSession = async (voiceRoomId) => {
  const session = musicSessions.get(voiceRoomId);
  if (!session || session.isPlaying) return;

  const nextTrack = session.queue.shift();
  if (!nextTrack) {
    session.current = null;
    session.isPaused = false;
    session.isPlaying = false;
    session.currentPositionSec = 0;
    emitMusicState(session, true);
    return;
  }

  ensureBotConnectedToRoomUsers(voiceRoomId);

  session.current = nextTrack;
  session.isPlaying = true;
  session.isPaused = false;
  resetPlaybackState(session);
  session.seekOffsetSec = 0;
  session.currentPositionSec = 0;
  void schedulePrefetchForSession(session);
  void prefetchTrack(nextTrack).catch(() => {});
  emitMusicState(session, true);

  try {
    await waitForPrefetchIfNeeded(nextTrack, MUSIC_CURRENT_PREFETCH_WAIT_TIMEOUT_MS);

    const localFilePath = getExistingPrefetchFilePath(nextTrack);
    if (!localFilePath) {
      const serverRoomId = getServerRoomIdFromVoiceRoomId(voiceRoomId);
      sendSystemMessage(serverRoomId, `Sarki oynatilamadi (indirme tamamlanamadi): ${nextTrack.title}`);
      disposeTrack(nextTrack);
      session.current = null;
      session.isPlaying = false;
      session.isPaused = false;
      resetPlaybackState(session);
      emitMusicState(session, true);
      void playNextInSession(voiceRoomId);
      return;
    }

    nextTrack.prefetchStatus = "playing";
    const playbackToken = session.activePlaybackToken + 1;
    session.activePlaybackToken = playbackToken;

    const ffmpegArgs = buildLocalPlaybackFfmpegArgs({
      filePath: localFilePath,
      volume: session.volume
    });

    const ffmpegBinary = process.env.FFMPEG_PATH || ffmpegPath || "ffmpeg";
    const ffmpeg = spawn(ffmpegBinary, ffmpegArgs, {
      stdio: ["ignore", "pipe", "pipe"]
    });

    let ffmpegErrorText = "";

    session.sourceProcess = null;
    session.ffmpegProcess = ffmpeg;
    session.isStoppingCurrent = false;
    startPlaybackTimer(session);

    ffmpeg.stdout.on("data", (chunk) => {
      if (session.activePlaybackToken !== playbackToken) return;
      if (!session.isPaused) {
        pumpChunkToRtcSource(session, chunk);
      }
    });

    ffmpeg.stderr.on("data", (data) => {
      if (session.activePlaybackToken !== playbackToken) return;
      const msg = data.toString().trim();
      if (msg) {
        ffmpegErrorText += `${msg}\n`;
        console.error("[MusicBot][FFmpeg]", msg);
      }
    });

    ffmpeg.on("close", (code) => {
      if (session.activePlaybackToken !== playbackToken) {
        return;
      }

      session.sourceProcess = null;
      session.ffmpegProcess = null;
      session.sourceEnded = true;

      if (session.playbackInterval && session.bufferedBytes >= FRAME_SIZE_BYTES) {
        const finalizeWhenDrained = setInterval(() => {
          if (session.activePlaybackToken !== playbackToken) {
            clearInterval(finalizeWhenDrained);
            return;
          }

          if (session.bufferedBytes >= FRAME_SIZE_BYTES) return;
          clearInterval(finalizeWhenDrained);
          stopPlaybackTimer(session);
          resetPlaybackState(session);
          disposeTrack(nextTrack);
          session.current = null;
          session.isPlaying = false;
          session.isPaused = false;

          const serverRoomId = getServerRoomIdFromVoiceRoomId(voiceRoomId);

          if (code !== 0 && !session.isStoppingCurrent) {
            sendSystemMessage(serverRoomId, `Sarki oynatilamadi: ${nextTrack.title}`);
            if (ffmpegErrorText.trim()) {
              console.error("[MusicBot] Local playback close error:", ffmpegErrorText.trim());
            }
            session.isStoppingCurrent = false;
            void playNextInSession(voiceRoomId);
            return;
          }

          if (!session.isStoppingCurrent) {
            sendSystemMessage(serverRoomId, `Sarki bitti: ${nextTrack.title}`);
          }

          session.isStoppingCurrent = false;
          emitMusicState(session, true);
          void playNextInSession(voiceRoomId);
        }, FRAME_DURATION_MS);
        return;
      }

      stopPlaybackTimer(session);
      resetPlaybackState(session);
      disposeTrack(nextTrack);
      session.current = null;
      session.isPlaying = false;
      session.isPaused = false;

      const serverRoomId = getServerRoomIdFromVoiceRoomId(voiceRoomId);

      if (code !== 0 && !session.isStoppingCurrent) {
        sendSystemMessage(serverRoomId, `Sarki oynatilamadi: ${nextTrack.title}`);
        if (ffmpegErrorText.trim()) {
          console.error("[MusicBot] Local playback close error:", ffmpegErrorText.trim());
        }
        session.isStoppingCurrent = false;
        void playNextInSession(voiceRoomId);
        return;
      }

      if (!session.isStoppingCurrent) {
        sendSystemMessage(serverRoomId, `Sarki bitti: ${nextTrack.title}`);
      }

      session.isStoppingCurrent = false;
      emitMusicState(session, true);
      void playNextInSession(voiceRoomId);
    });
  } catch (err) {
    console.error("[MusicBot] Failed to start track:", err.message);
    disposeTrack(nextTrack);
    session.current = null;
    session.isPlaying = false;
    session.isPaused = false;
    resetPlaybackState(session);

    const serverRoomId = voiceRoomId.substring(0, voiceRoomId.lastIndexOf("-"));
    sendSystemMessage(serverRoomId, `Sarki oynatilamadi: ${nextTrack.title}`);
    emitMusicState(session, true);
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
      const session = getOrCreateMusicSession(voiceRoomId);
      ensureBotConnectedToRoomUsers(voiceRoomId);
      sendSystemMessage(roomId, `Muzik botu hazirlaniyor, parca araniyor: ${query}`);

      const track = await resolveTrack(query);

      const queuedTrack = createQueuedTrack(track, user.username);
      const shouldPrefetchImmediately = !session.current && !session.isPlaying;
      session.queue.push(queuedTrack);

      if (shouldPrefetchImmediately) {
        sendSystemMessage(roomId, `Parca MP3 olarak indiriliyor: ${track.title}`);
        try {
          await prefetchTrack(queuedTrack);
        } catch (prefetchErr) {
          session.queue = session.queue.filter((item) => item.id !== queuedTrack.id);
          emitMusicState(session, true);
          throw prefetchErr;
        }
      }

      if (session.current || session.isPlaying || !shouldPrefetchImmediately) {
        void schedulePrefetchForSession(session);
      }
      emitMusicState(session, true);

      sendSystemMessage(roomId, `Kuyruga eklendi: ${track.title}`);
      void playNextInSession(voiceRoomId);
    } catch (err) {
      const message = err?.message || "Bilinmeyen hata";
      console.error("[MusicBot] /play error:", message);
      if (isYouTubeBotCheckError(message)) {
        const cookieHint = hasYtDlpCookies()
          ? "Cookie dosyasi var ama gecersiz olabilir; yenileyip tekrar dene."
          : `Sunucuya cookie dosyasi ekle: ${ytDlpCookiesPath}`;
        sendSystemMessage(roomId, `YouTube bu parca icin bot dogrulamasi istiyor. ${cookieHint}`);
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
    emitMusicState(session, true);
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
      emitMusicState(session, true);
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
      emitMusicState(session, true);
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
    emitMusicState(session, true);
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

    const activeMusicSession = findMusicSessionByServerRoomId(roomId);
    socket.emit("music-state", activeMusicSession ? buildMusicStatePayload(activeMusicSession) : buildEmptyMusicStatePayload(roomId));
    
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
      const trimmedContent = typeof content === "string" ? content.trim() : "";
      const isSlashCommand = type === "text" && trimmedContent.startsWith("/");

      if (isSlashCommand) {
        saveAndBroadcastMessage({
          content: trimmedContent,
          userId,
          username: user.username,
          type: "command",
          roomId,
          fileUrl,
          fileName
        });

        const wasHandled = await handleMusicCommand({
          socket,
          roomId,
          user,
          commandText: trimmedContent
        });

        if (wasHandled) {
          return;
        }

        return;
      }

      saveAndBroadcastMessage({
        content,
        userId,
        username: user.username,
        type,
        roomId,
        fileUrl,
        fileName
      });
      
    } catch (err) {
      console.error("[Message] Error saving message:", err);
      socket.emit("message-error", { error: "Failed to save message" });
    }
  });

  socket.on("music-control", async (payload = {}) => {
    const roomId = typeof payload.roomId === "string" ? payload.roomId : "";
    const action = typeof payload.action === "string" ? payload.action : "";
    const voiceRoomId = socketToRoom[socket.id];
    const textRoomId = socketToTextRoom[socket.id];

    if (!roomId || textRoomId !== roomId) {
      socket.emit("music-control-error", { error: "Bu odadaki muzik kontrolu icin once odaya katilmalisin." });
      return;
    }

    const session = voiceRoomId && voiceRoomId.startsWith(`${roomId}-`)
      ? musicSessions.get(voiceRoomId)
      : findMusicSessionByServerRoomId(roomId);
    if (!session) {
      socket.emit("music-control-error", { error: "Bu odada aktif muzik yok." });
      return;
    }

    const sessionVoiceRoomId = session.voiceRoomId;

    if (!action) {
      socket.emit("music-control-error", { error: "Desteklenmeyen muzik kontrolu." });
      return;
    }

    const now = Date.now();
    if (session.controlActionInFlight && action !== "volume") {
      socket.emit("music-control-error", { error: "Muzik kontrolu isleniyor, tekrar dene." });
      return;
    }

    if (action !== "volume" && now - (session.lastControlActionAt || 0) < MUSIC_CONTROL_COOLDOWN_MS) {
      return;
    }

    if (action !== "volume") {
      session.controlActionInFlight = true;
      session.lastControlActionAt = now;
    }

    try {
      if (action === "toggle") {
        if (!session.ffmpegProcess) {
          socket.emit("music-control-error", { error: "Kontrol edilecek aktif oynatma yok." });
          return;
        }

        if (session.isPaused) {
          if (process.platform === "win32") {
            socket.emit("music-control-error", { error: "Bu platformda devam ettirme desteklenmiyor." });
            return;
          }
          try {
            session.ffmpegProcess.kill("SIGCONT");
            session.isPaused = false;
            sendSystemMessage(roomId, "Muzik devam ediyor.");
            emitMusicState(session, true);
          } catch {
            socket.emit("music-control-error", { error: "Muzik devam ettirilemedi." });
          }
          return;
        }

        if (process.platform === "win32") {
          socket.emit("music-control-error", { error: "Bu platformda duraklatma desteklenmiyor." });
          return;
        }

        try {
          session.ffmpegProcess.kill("SIGSTOP");
          session.isPaused = true;
          sendSystemMessage(roomId, "Muzik duraklatildi.");
          emitMusicState(session, true);
        } catch {
          socket.emit("music-control-error", { error: "Muzik duraklatilamadi." });
        }
        return;
      }

      if (action === "skip") {
        stopCurrentPlayback(session);
        sendSystemMessage(roomId, "Parca atlandi.");
        emitMusicState(session, true);
        void playNextInSession(sessionVoiceRoomId);
        return;
      }

      if (action === "stop") {
        closeMusicSession(sessionVoiceRoomId, "Muzik durduruldu.");
        return;
      }

      if (action === "volume") {
        const nextVolume = Number(payload.value);
        if (Number.isNaN(nextVolume) || nextVolume < 0 || nextVolume > 200) {
          socket.emit("music-control-error", { error: "Ses 0-200 arasinda olmali." });
          return;
        }

        session.volume = nextVolume;
        emitMusicState(session, true);
        return;
      }

      if (action === "seek") {
        const current = session.current;
        const duration = Number(current?.durationInSec || 0);
        const target = Number(payload.value);
        if (!current || duration <= 0 || Number.isNaN(target)) {
          socket.emit("music-control-error", { error: "Bu parca icin ilerletme kullanilamiyor." });
          return;
        }

        const filePath = getExistingPrefetchFilePath(current);
        if (!filePath) {
          socket.emit("music-control-error", { error: "Ilerletme icin parcanin onbellege alinmasi gerekiyor." });
          return;
        }

        const seekSec = Math.max(0, Math.min(target, duration));

        try {
          stopCurrentPlayback(session);
          session.current = current;
          session.isPlaying = true;
          session.isPaused = false;
          session.seekOffsetSec = seekSec;
          session.currentPositionSec = seekSec;
          const playbackToken = session.activePlaybackToken + 1;
          session.activePlaybackToken = playbackToken;

          const ffmpegArgs = buildLocalPlaybackFfmpegArgs({
            filePath,
            volume: session.volume,
            seekSec
          });

          const ffmpegBinary = process.env.FFMPEG_PATH || ffmpegPath || "ffmpeg";
          const ffmpeg = spawn(ffmpegBinary, ffmpegArgs, {
            stdio: ["ignore", "pipe", "pipe"]
          });
          let ffmpegErrorText = "";

          session.sourceProcess = null;
          session.ffmpegProcess = ffmpeg;
          session.sourceEnded = false;
          session.isStoppingCurrent = false;

          ffmpeg.stdout.on("data", (chunk) => {
            if (session.activePlaybackToken !== playbackToken) return;
            if (!session.isPaused) {
              pumpChunkToRtcSource(session, chunk);
            }
          });

          ffmpeg.stderr.on("data", (data) => {
            if (session.activePlaybackToken !== playbackToken) return;
            const msg = data.toString().trim();
            if (msg) {
              ffmpegErrorText += `${msg}\n`;
              console.error("[MusicBot][FFmpeg][seek]", msg);
            }
          });

          ffmpeg.on("close", (code) => {
            if (session.activePlaybackToken !== playbackToken) {
              return;
            }

            session.sourceProcess = null;
            session.ffmpegProcess = null;
            session.sourceEnded = true;
            stopPlaybackTimer(session);
            resetPlaybackState(session);

            if (code !== 0 && !session.isStoppingCurrent) {
              console.error("[MusicBot] Seek playback closed with error code:", code);
              if (ffmpegErrorText.trim()) {
                console.error("[MusicBot] Seek close error:", ffmpegErrorText.trim());
              }
              session.current = current;
              session.isPlaying = false;
              session.isPaused = false;
              session.currentPositionSec = seekSec;
              emitMusicState(session, true);
              socket.emit("music-control-error", { error: "Ilerletme sirasinda oynatma kesildi. Tekrar dene." });
              return;
            }

            session.current = null;
            session.isPlaying = false;
            session.isPaused = false;
            emitMusicState(session, true);
            void playNextInSession(sessionVoiceRoomId);
          });

          startPlaybackTimer(session);
          emitMusicState(session, true);
        } catch (err) {
          socket.emit("music-control-error", { error: err?.message || "Ilerletme basarisiz." });
        }
        return;
      }

      socket.emit("music-control-error", { error: "Desteklenmeyen muzik kontrolu." });
    } finally {
      if (action !== "volume") {
        session.controlActionInFlight = false;
      }
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
      const session = musicSessions.get(roomId);
      connectBotToUser(roomId, socket.id);
      emitMusicState(session, true);
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
          trickle: true,
          stream: session.stream,
          wrtc: RTC,
          config: {
            iceServers: ICE_SERVERS
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
  console.log(`[MusicBot] yt-dlp binary: ${ytDlpBinary}`);
  console.log(`[Voice] ICE servers: ${ICE_SERVERS.map((item) => item.urls).join(", ")}`);
  console.log(`[MusicBot] yt-dlp cookies: ${hasYtDlpCookies() ? `found (${ytDlpCookiesPath})` : `missing (${ytDlpCookiesPath})`}`);
});
