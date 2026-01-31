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

// Get Messages (Filtered by Room)
app.get("/api/messages", (req, res) => {
  try {
    const roomId = req.query.roomId || "general";
    const messages = db.prepare("SELECT * FROM messages WHERE room_id = ? ORDER BY created_at ASC LIMIT 50").all(roomId);
    res.json(messages);
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
    
    const stmt = db.prepare("INSERT INTO rooms (id, name, created_by, password) VALUES (?, ?, ?, ?)");
    stmt.run(id, name, userId || 0, password || null);
    
    const newRoom = { id, name, created_by: userId || 0, isPrivate: !!password };
    io.emit("room-created", newRoom); // Notify clients
    res.status(201).json(newRoom);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to create room" });
  }
});

// --- Socket.io ---

const httpServer = new HttpServer(app);
const io = new SocketIOServer(httpServer, {
  cors: {
    origin: "*", 
    methods: ["GET", "POST"]
  }
});

// Health check
app.get("/", (req, res) => {
  res.send("V A T A N A S K I Server is running");
});

const usersInVoice = {}; // { roomId: [{ id, username }] }
const usersInRoom = {}; // { roomId: { socketId: username } } for text/presence
const socketToRoom = {}; // { socketId: roomId }

  // Broadcast all voice room users to all connected clients
  const broadcastAllVoiceUsers = () => {
    io.emit("all-rooms-users", usersInVoice);
  };

  // Helper to get active users count per room for the rooms API
  const getRoomStats = () => {
    const stats = {};
    for (const [roomId, users] of Object.entries(usersInRoom)) {
      const uniqueNames = [...new Set(Object.values(users))]; // unique usernames
      stats[roomId] = {
        count: uniqueNames.length,
        users: uniqueNames
      };
    }
    return stats;
  };

  io.on("connection", (socket) => {
    console.log("User connected:", socket.id);
    
    // Send current voice users to new connection
    socket.emit("all-rooms-users", usersInVoice);

    socket.on("ui-interaction", (data) => {
    // Broadcast to everyone else (excluding sender)
    // Rate limit check could happen here too, but client-side is mostly enough for UI feedback
    socket.broadcast.emit("play-ui-sound", { type: data.type, userId: socket.id });
  });

  // Join a Text/Socket Room
  socket.on("join-room", (data) => {
    // data can be roomId string or object { roomId, username }
    const roomId = typeof data === 'object' ? data.roomId : data;
    const username = typeof data === 'object' ? data.username : "Anonymous";

    socket.join(roomId);
    console.log(`User ${socket.id} (${username}) joined text room ${roomId}`);
    
    // Track user in room
    if (!usersInRoom[roomId]) {
      usersInRoom[roomId] = {};
    }
    usersInRoom[roomId][socket.id] = username;
    
    // Store mapping for disconnect
    // Note: socketToRoom is used for voice, we might need another map or just reuse it carefully.
    // Since a user might be in text room X and voice room Y, let's keep text tracking separate or assume they are the same.
    // For now, let's just track it in usersInRoom.
  });

  socket.on("send-message", (data) => {
    const { content, user, type = "text", fileUrl, fileName, roomId = "general" } = data;
    
    // Save to DB
    try {
      const stmt = db.prepare("INSERT INTO messages (content, user_id, username, type, room_id) VALUES (?, ?, ?, ?, ?)");
      const info = stmt.run(content, user.id, user.username, type, roomId);
      
      const message = {
        id: info.lastInsertRowid,
        content,
        user_id: user.id,
        username: user.username,
        type,
        fileUrl,
        fileName,
        room_id: roomId,
        created_at: new Date().toISOString()
      };

      // Broadcast to specific room
      io.to(roomId).emit("message-received", message);
      console.log(`Message sent to room ${roomId}: ${content}`);
      
    } catch (err) {
      console.error("Error saving message:", err);
    }
  });

  socket.on("disconnect", () => {
    console.log("User disconnected:", socket.id);
    
    // Remove from text rooms
    for (const roomId in usersInRoom) {
      if (usersInRoom[roomId][socket.id]) {
        delete usersInRoom[roomId][socket.id];
      }
    }

    // Remove user from voice list if they were in it
    const roomID = socketToRoom[socket.id];
    let room = usersInVoice[roomID];
    if (room) {
      room = room.filter(u => u.id !== socket.id);
      usersInVoice[roomID] = room;
      // Notify others to remove this peer
      socket.broadcast.to(roomID).emit('user-left-voice', socket.id);
      // Broadcast updated room list
      broadcastAllVoiceUsers();
    }
  });

  socket.on("join-voice", (data) => {
    // data can be just roomId (string) or object { roomId, user }
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
        username: payload.username // Pass username through signal
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
      socket.broadcast.to(roomID).emit('user-left-voice', socket.id); // Broadcast to room only
      broadcastAllVoiceUsers();
    }
    if (roomID) socket.leave(roomID); // Leave socket room
    delete socketToRoom[socket.id];
  });

});

httpServer.listen(port, () => {
  console.log(`Server running on port ${port}`);
});
