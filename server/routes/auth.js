import express from "express";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import db from "../db.js";

const router = express.Router();
const SECRET_KEY = process.env.JWT_SECRET || "super-secret-dev-key"; // Move to .env later

// Register
router.post("/register", async (req, res) => {
  const { username, password } = req.body;

  if (!username || !password) {
    return res.status(400).json({ error: "Username and password required" });
  }

  try {
    const hashedPassword = await bcrypt.hash(password, 10);
    const insert = db.prepare("INSERT INTO users (username, password) VALUES (?, ?)");
    const result = insert.run(username, hashedPassword);

    const token = jwt.sign({ id: result.lastInsertRowid, username }, SECRET_KEY, { expiresIn: "7d" });

    res.status(201).json({ 
      success: true, 
      token, 
      user: { id: result.lastInsertRowid, username } 
    });
  } catch (error) {
    if (error.code === 'SQLITE_CONSTRAINT_UNIQUE') {
      return res.status(409).json({ error: "Username already exists" });
    }
    console.error(error);
    res.status(500).json({ error: "Internal server error" });
  }
});

// Login
router.post("/login", async (req, res) => {
  const { username, password } = req.body;

  try {
    const user = db.prepare("SELECT * FROM users WHERE username = ?").get(username);

    if (!user) {
      return res.status(401).json({ error: "Invalid credentials" });
    }

    const validPassword = await bcrypt.compare(password, user.password);
    if (!validPassword) {
      return res.status(401).json({ error: "Invalid credentials" });
    }

    const token = jwt.sign({ id: user.id, username: user.username }, SECRET_KEY, { expiresIn: "7d" });

    res.json({ 
      success: true, 
      token, 
      user: { id: user.id, username: user.username } 
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Internal server error" });
  }
});

export default router;
