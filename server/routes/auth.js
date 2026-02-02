import express from "express";
import jwt from "jsonwebtoken";
import db from "../db.js";

const router = express.Router();
const SECRET_KEY = process.env.JWT_SECRET || "super-secret-dev-key";

// Login (Create account if not exists)
router.post("/login", async (req, res) => {
  const { username } = req.body;

  if (!username) {
    return res.status(400).json({ error: "Username required" });
  }

  try {
    let user = db.prepare("SELECT * FROM users WHERE username = ?").get(username);

    if (!user) {
      // Register new user (password is dummy 'nopass')
      const insert = db.prepare("INSERT INTO users (username, password) VALUES (?, ?)");
      const result = insert.run(username, 'nopass');
      // Convert BigInt to Number for JSON serialization
      user = { id: Number(result.lastInsertRowid), username };
    } else {
      // Ensure id is a Number
      user = { id: Number(user.id), username: user.username };
    }

    const token = jwt.sign({ id: user.id, username: user.username }, SECRET_KEY, { expiresIn: "30d" });

    res.json({ 
      success: true, 
      token, 
      user: { id: Number(user.id), username: user.username } 
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Internal server error" });
  }
});

// Register endpoint (Redirects to login logic for backward compatibility/clarity)
router.post("/register", async (req, res) => {
  // Just forward to login logic since we auto-create
  return router.handle(req, res);
});

export default router;
