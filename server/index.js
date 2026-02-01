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
const socketToRoom = {}; // { socketId: roomId } for voice
const socketToTextRoom = {}; // { socketId: roomId } for text

  // Broadcast all voice room users to all connected clients
  const broadcastAllVoiceUsers = () => {
    io.emit("all-rooms-users", usersInVoice);
  };

  // Helper to get active users count per room for the rooms API
  const getRoomStats = () => {
    const stats = {};
    
    // Method 1: Count text/presence users from usersInRoom
    for (const [roomId, users] of Object.entries(usersInRoom)) {
      const userValues = Object.values(users);
      if (userValues.length > 0) {
        const uniqueNames = [...new Set(userValues)];
        stats[roomId] = {
          count: uniqueNames.length,
          users: uniqueNames
        };
      }
    }
    
    // Method 2: Also include voice users in stats (merge with text users)
    for (const [roomId, users] of Object.entries(usersInVoice)) {
        if (users.length === 0) continue; // Skip empty voice rooms
        
        if (!stats[roomId]) {
            stats[roomId] = { count: 0, users: [] };
        }
        // Voice users are objects {id, username}
        const voiceNames = users.map(u => u.username);
        // Merge unique
        const allUsers = [...new Set([...stats[roomId].users, ...voiceNames])];
        stats[roomId].count = allUsers.length;
        stats[roomId].users = allUsers;
    }
    
    // Method 3: Fallback - Also check Socket.io's internal room tracking
    // This helps if server restarted but clients are still connected
    try {
        const adapterRooms = io.sockets.adapter.rooms;
        for (const [roomId, socketSet] of adapterRooms.entries()) {
            // Skip socket IDs (they also appear as room names in Socket.io)
            if (roomId.length > 30) continue; // Socket IDs are long strings
            
            const socketsInRoom = socketSet.size;
            if (socketsInRoom > 0 && !stats[roomId]) {
                // Room has connected sockets but we don't have user info
                // At least mark it as having users
                stats[roomId] = {
                    count: socketsInRoom,
                    users: [`${socketsInRoom} connected`]
                };
            } else if (socketsInRoom > 0 && stats[roomId]) {
                // Update count to be at least the socket count
                stats[roomId].count = Math.max(stats[roomId].count, socketsInRoom);
            }
        }
    } catch (err) {
        console.log("[getRoomStats] Could not check adapter rooms:", err.message);
    }
    
    return stats;
  };

  // Cleanup Empty Rooms (Every 30 seconds)
  setInterval(() => {
      try {
          const rooms = db.prepare("SELECT * FROM rooms").all();
          const stats = getRoomStats();
          const now = Date.now();
          const TIMEOUT = 30 * 1000; // 30 seconds grace period for new rooms

          // Debug: Log current state
          console.log(`[Cleanup] Checking ${rooms.length} rooms. Active stats:`, JSON.stringify(stats));

          rooms.forEach(room => {
              const activeCount = stats[room.id]?.count || 0;
              const createdAt = new Date(room.created_at).getTime();
              
              let createdTime = createdAt;
              if (isNaN(createdTime)) {
                  createdTime = now; 
              }

              const ageSeconds = Math.floor((now - createdTime) / 1000);
              
              // Only delete if room is empty AND older than TIMEOUT
              if (activeCount === 0 && (now - createdTime > TIMEOUT)) {
                  console.log(`[Cleanup] Deleting empty room: ${room.name} (${room.id}), age: ${ageSeconds}s`);
                  db.prepare("DELETE FROM rooms WHERE id = ?").run(room.id);
                  io.emit("room-deleted", room.id);
              } else if (activeCount > 0) {
                  console.log(`[Cleanup] Room ${room.name} has ${activeCount} active users - keeping`);
              }
          });
          
          // Clean up empty usersInRoom entries
          for (const roomId in usersInRoom) {
              if (Object.keys(usersInRoom[roomId]).length === 0) {
                  delete usersInRoom[roomId];
              }
          }
          
          // Clean up empty usersInVoice entries
          for (const roomId in usersInVoice) {
              if (usersInVoice[roomId].length === 0) {
                  delete usersInVoice[roomId];
              }
          }
      } catch (err) {
          console.error("Cleanup error:", err);
      }
  }, 30000); // Check every 30s

  io.on("connection", (socket) => {
    console.log("User connected:", socket.id);
    
    // Send current voice users to new connection
    socket.emit("all-rooms-users", usersInVoice);

  // Join a Text/Socket Room
  socket.on("join-room", (data) => {
    // data can be roomId string or object { roomId, username }
    const roomId = typeof data === 'object' ? data.roomId : data;
    const username = typeof data === 'object' ? data.username : "Anonymous";

    // Leave previous text room if any
    const previousRoom = socketToTextRoom[socket.id];
    if (previousRoom && previousRoom !== roomId) {
      if (usersInRoom[previousRoom] && usersInRoom[previousRoom][socket.id]) {
        delete usersInRoom[previousRoom][socket.id];
        console.log(`[Join] User ${socket.id} left previous room ${previousRoom}`);
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
    
    const currentCount = Object.keys(usersInRoom[roomId]).length;
    console.log(`[Join] User ${socket.id} (${username}) joined room ${roomId}. Total in room: ${currentCount}`);
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
    
    // Remove from text room using socketToTextRoom mapping
    const textRoomId = socketToTextRoom[socket.id];
    if (textRoomId && usersInRoom[textRoomId] && usersInRoom[textRoomId][socket.id]) {
      const username = usersInRoom[textRoomId][socket.id];
      delete usersInRoom[textRoomId][socket.id];
      console.log(`[Disconnect] Removed ${username} from text room ${textRoomId}. Remaining: ${Object.keys(usersInRoom[textRoomId]).length}`);
    }
    delete socketToTextRoom[socket.id];

    // Remove user from voice list if they were in it
    const roomID = socketToRoom[socket.id];
    let room = usersInVoice[roomID];
    if (room) {
      const username = room.find(u => u.id === socket.id)?.username;
      room = room.filter(u => u.id !== socket.id);
      usersInVoice[roomID] = room;
      console.log(`[Disconnect] Removed ${username} from voice room ${roomID}. Remaining: ${room.length}`);
      // Notify others to remove this peer
      socket.broadcast.to(roomID).emit('user-left-voice', socket.id);
      // Broadcast updated room list
      broadcastAllVoiceUsers();
    }
    delete socketToRoom[socket.id];
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
