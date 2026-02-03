import Database from "better-sqlite3";
import path from "path";
import fs from "fs";

// Ensure data directory exists
const dataDir = path.join(process.cwd(), "data");
if (!fs.existsSync(dataDir)) {
  fs.mkdirSync(dataDir);
}

const db = new Database(path.join(dataDir, "app.db"));

// Initialize Users Table
db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT UNIQUE NOT NULL,
    password TEXT NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )
`);

// Initialize Messages Table
db.exec(`
  CREATE TABLE IF NOT EXISTS messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    content TEXT NOT NULL,
    user_id INTEGER NOT NULL,
    username TEXT NOT NULL,
    type TEXT DEFAULT 'text',
    room_id TEXT DEFAULT 'general',
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY(user_id) REFERENCES users(id)
  )
`);

// Initialize Rooms Table
db.exec(`
  CREATE TABLE IF NOT EXISTS rooms (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    created_by INTEGER,
    password TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )
`);

// Attempt to add password column if it doesn't exist (migration for existing dbs)
try {
  db.exec("ALTER TABLE rooms ADD COLUMN password TEXT");
} catch (err) {
  // Column likely exists
}

// Room Sessions Table - Persistent user tracking
// This replaces RAM-based tracking for reliability across restarts
db.exec(`
  CREATE TABLE IF NOT EXISTS room_sessions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    room_id TEXT NOT NULL,
    socket_id TEXT NOT NULL,
    username TEXT NOT NULL,
    session_type TEXT DEFAULT 'text',
    joined_at TEXT DEFAULT CURRENT_TIMESTAMP,
    last_heartbeat TEXT DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(room_id, socket_id, session_type)
  )
`);

// Create index for faster queries
try {
  db.exec("CREATE INDEX IF NOT EXISTS idx_room_sessions_room_id ON room_sessions(room_id)");
  db.exec("CREATE INDEX IF NOT EXISTS idx_room_sessions_socket_id ON room_sessions(socket_id)");
  db.exec("CREATE INDEX IF NOT EXISTS idx_room_sessions_heartbeat ON room_sessions(last_heartbeat)");
} catch (err) {
  // Indexes may already exist
}

// NOTE: Seed data removed as per request. Default state is empty.

export default db;
