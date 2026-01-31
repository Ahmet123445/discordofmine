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

// History Endpoint
app.get("/api/messages", (req, res) => {
  try {
    const messages = db.prepare("SELECT * FROM messages ORDER BY created_at ASC LIMIT 50").all();
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
    io.emit("message-deleted", { id: Number(id) });
    
    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to delete message" });
  }
});

const httpServer = new HttpServer(app);
const io = new SocketIOServer(httpServer, {
  cors: {
    origin: "*", 
    methods: ["GET", "POST"]
  }
});

// Health check
app.get("/", (req, res) => {
  res.send("DiscordOfMine Server is running");
});

const usersInVoice = {}; // { roomId: [socketId1, socketId2] }
const socketToRoom = {}; // { socketId: roomId }

io.on("connection", (socket) => {
  console.log("User connected:", socket.id);

  socket.on("join-room", (roomId) => {
    socket.join(roomId);
    console.log(`User ${socket.id} joined room ${roomId}`);
  });

  socket.on("send-message", (data) => {
    const { content, user, type = "text", fileUrl, fileName } = data;
    
    // Save to DB
    try {
      // Note: We might need to alter table if we want dedicated columns for fileUrl, 
      // but for now we can embed it in content or handle it via type.
      // Let's assume content stores the text OR the file URL if type is 'file'
      
      const stmt = db.prepare("INSERT INTO messages (content, user_id, username, type) VALUES (?, ?, ?, ?)");
      const info = stmt.run(content, user.id, user.username, type);
      
      const message = {
        id: info.lastInsertRowid,
        content,
        user_id: user.id,
        username: user.username,
        type,
        fileUrl, // Pass through for real-time clients
        fileName,
        created_at: new Date().toISOString()
      };

      // Broadcast
      io.emit("message-received", message);
      
    } catch (err) {
      console.error("Error saving message:", err);
    }
  });

  socket.on("disconnect", () => {
    console.log("User disconnected:", socket.id);
    // Remove user from voice list if they were in it
    const roomID = socketToRoom[socket.id];
    let room = usersInVoice[roomID];
    if (room) {
      room = room.filter(u => u.id !== socket.id);
      usersInVoice[roomID] = room;
      // Notify others to remove this peer
      socket.broadcast.to(roomID).emit('user-left-voice', socket.id);
    }
  });

  socket.on("join-voice", (data) => {
    // data can be just roomId (string) or object { roomId, user }
    // Handle legacy calls just in case, though we will update client
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

    // Send existing users to the new joiner
    // Filter out self
    const usersInThisRoom = usersInVoice[roomId].filter(u => u.id !== socket.id);
    socket.emit("all-voice-users", usersInThisRoom);
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
      socket.broadcast.emit('user-left-voice', socket.id);
    }
    delete socketToRoom[socket.id];
  });

});

httpServer.listen(port, () => {
  console.log(`Server running on port ${port}`);
});
