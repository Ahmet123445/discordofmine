import { Server as SocketIOServer } from "socket.io";
import { Server as HttpServer } from "http";
import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import db from "./db.js";
import authRoutes from "./routes/auth.js";
import uploadRoutes from "./routes/upload.js";
import path from "path";

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
  // CRITICAL: Ping/Pong settings to prevent Render timeout
  pingTimeout: 60000,      // 60 seconds - how long to wait for pong
  pingInterval: 25000,     // 25 seconds - send ping every 25s (Render timeout is 30s)
  transports: ['websocket', 'polling'],
  allowUpgrades: true
});

// Health check - also keeps Render awake
app.get("/", (req, res) => {
  res.send("Server is running - " + new Date().toISOString());
});

// Keep-alive endpoint for external pinging
app.get("/health", (req, res) => {
  res.json({ status: "ok", uptime: process.uptime(), connections: io.engine.clientsCount });
});

const usersInVoice = {}; // { roomId: [{ id, username }] }
const usersInRoom = {}; // { roomId: { socketId: username } } for text/presence
const socketToRoom = {}; // { socketId: roomId } for voice
const socketToTextRoom = {}; // { socketId: roomId } for text
const roomEmptyTimestamps = {}; // { roomId: timestamp } - when room became empty

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
 * Get the REAL user count for a room by checking ALL possible sources
 * This function is the SINGLE SOURCE OF TRUTH for user counts
 */
const getRealUserCount = (roomId) => {
  let count = 0;
  const usernames = new Set();
  
  // Source 1: Text/presence users (usersInRoom)
  if (usersInRoom[roomId]) {
    const textUsers = Object.values(usersInRoom[roomId]);
    textUsers.forEach(name => {
      if (name) usernames.add(name);
    });
    count += textUsers.length;
  }
  
  // Source 2: Voice users - check all voice channels for this server
  // Voice room format: "serverid-channelname" (e.g., "myroom-1234-general")
  for (const [voiceRoomId, users] of Object.entries(usersInVoice)) {
    if (!users || users.length === 0) continue;
    
    // Check if this voice room belongs to this server
    // Voice room: "myroom-1234-general", Server: "myroom-1234"
    if (voiceRoomId.startsWith(roomId + '-') || voiceRoomId === roomId) {
      users.forEach(u => {
        if (u && u.username) usernames.add(u.username);
      });
      count += users.length;
    }
  }
  
  // Source 3: Socket.io adapter rooms (fallback)
  try {
    const adapterRoom = io.sockets.adapter.rooms.get(roomId);
    if (adapterRoom && adapterRoom.size > 0) {
      count = Math.max(count, adapterRoom.size);
    }
  } catch (e) {
    // Ignore adapter errors
  }
  
  return {
    count: Math.max(count, usernames.size),
    users: Array.from(usernames)
  };
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
// Runs every 10 seconds to check for rooms that should be deleted
// ============================================================================
setInterval(() => {
  try {
    const rooms = db.prepare("SELECT * FROM rooms").all();
    const now = Date.now();
    const DELETE_AFTER_MS = 30 * 1000; // 30 seconds

    rooms.forEach(room => {
      const { count } = getRealUserCount(room.id);
      
      // RULE 1: If room has users, it's PROTECTED - NEVER delete
      if (count > 0) {
        markRoomAsOccupied(room.id);
        return; // Skip this room entirely
      }
      
      // RULE 2: Room is empty - start/check countdown
      markRoomAsEmpty(room.id);
      
      const emptyTime = roomEmptyTimestamps[room.id];
      if (emptyTime && (now - emptyTime >= DELETE_AFTER_MS)) {
        // Final safety check before deletion
        if (isRoomProtected(room.id)) {
          console.log(`[Cleanup] BLOCKED deletion of ${room.id} - users detected at last moment`);
          markRoomAsOccupied(room.id);
          return;
        }
        
        console.log(`[Cleanup] Deleting empty room: ${room.name} (${room.id}) - empty for 30+ seconds`);
        db.prepare("DELETE FROM rooms WHERE id = ?").run(room.id);
        io.emit("room-deleted", room.id);
        delete roomEmptyTimestamps[room.id];
      }
    });
    
    // Clean up tracking objects for non-existent rooms
    for (const roomId in usersInRoom) {
      if (Object.keys(usersInRoom[roomId]).length === 0) {
        delete usersInRoom[roomId];
      }
    }
    
    for (const roomId in usersInVoice) {
      if (usersInVoice[roomId].length === 0) {
        delete usersInVoice[roomId];
      }
    }
  } catch (err) {
    console.error("Cleanup error:", err);
  }
}, 10000); // Check every 10 seconds

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
    
    // Track user in room
    if (!usersInRoom[roomId]) {
      usersInRoom[roomId] = {};
    }
    usersInRoom[roomId][socket.id] = username;
    
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
    
    // Remove from text room
    const textRoomId = socketToTextRoom[socket.id];
    if (textRoomId && usersInRoom[textRoomId] && usersInRoom[textRoomId][socket.id]) {
      delete usersInRoom[textRoomId][socket.id];
      // Check if room is now empty
      if (Object.keys(usersInRoom[textRoomId]).length === 0) {
        markRoomAsEmpty(textRoomId);
      }
    }
    delete socketToTextRoom[socket.id];

    // Remove user from voice list
    const roomID = socketToRoom[socket.id];
    let room = usersInVoice[roomID];
    if (room) {
      room = room.filter(u => u.id !== socket.id);
      usersInVoice[roomID] = room;
      socket.broadcast.to(roomID).emit('user-left-voice', socket.id);
      broadcastAllVoiceUsers();
      
      // Check if voice room's server is now empty
      // Voice room format: "serverid-channelname"
      if (room.length === 0) {
        const lastDash = roomID.lastIndexOf('-');
        if (lastDash > 0) {
          const serverId = roomID.substring(0, lastDash);
          // Only mark as empty if no other voice channels have users
          let serverHasUsers = false;
          for (const [vRoomId, vUsers] of Object.entries(usersInVoice)) {
            if (vRoomId.startsWith(serverId + '-') && vUsers && vUsers.length > 0) {
              serverHasUsers = true;
              break;
            }
          }
          if (!serverHasUsers && !isRoomProtected(serverId)) {
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
    
    // Add to voice list
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
    
    // CRITICAL: Mark the server as occupied
    // Voice room format: "serverid-channelname"
    const lastDash = roomId.lastIndexOf('-');
    if (lastDash > 0) {
      const serverId = roomId.substring(0, lastDash);
      markRoomAsOccupied(serverId);
    }

    // Send existing users to the new joiner
    const usersInThisRoom = usersInVoice[roomId].filter(u => u.id !== socket.id);
    socket.emit("all-voice-users", usersInThisRoom);
    
    // Broadcast updated room list to everyone
    broadcastAllVoiceUsers();
  });

  socket.on("sending-signal", payload => {
    io.to(payload.userToSignal).emit('user-joined-voice', { 
      signal: payload.signal, 
      callerID: payload.callerID,
      username: payload.username
    });
  });

  socket.on("returning-signal", payload => {
    io.to(payload.callerID).emit('receiving-returned-signal', { signal: payload.signal, id: socket.id });
  });

  socket.on("leave-voice", () => {
    const roomID = socketToRoom[socket.id];
    let room = usersInVoice[roomID];
    if (room) {
      room = room.filter(u => u.id !== socket.id);
      usersInVoice[roomID] = room;
      socket.broadcast.to(roomID).emit('user-left-voice', socket.id);
      broadcastAllVoiceUsers();
      
      // Check if voice room's server is now empty
      if (room.length === 0 && roomID) {
        const lastDash = roomID.lastIndexOf('-');
        if (lastDash > 0) {
          const serverId = roomID.substring(0, lastDash);
          // Only mark as empty if no other voice channels have users
          let serverHasUsers = false;
          for (const [vRoomId, vUsers] of Object.entries(usersInVoice)) {
            if (vRoomId.startsWith(serverId + '-') && vUsers && vUsers.length > 0) {
              serverHasUsers = true;
              break;
            }
          }
          if (!serverHasUsers && !isRoomProtected(serverId)) {
            markRoomAsEmpty(serverId);
          }
        }
      }
    }
    if (roomID) socket.leave(roomID);
    delete socketToRoom[socket.id];
  });

});

httpServer.listen(port, () => {
  console.log(`Server running on port ${port}`);
});
