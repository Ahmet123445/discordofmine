// Minimal REST surface for the radio module. Mounted via radioRestMount(app).

import {
  getAllStations,
  getStationsByCategory,
  getCategories
} from "./stationRegistry.js";
import { radioSessions } from "./radioSession.js";
import { buildRadioStatePayload, buildEmptyRadioStatePayload } from "./radioPlayer.js";
import { isRadioEnabled } from "./adapter.js";

const featureFlagGuard = (req, res, next) => {
  if (!isRadioEnabled()) {
    return res.status(503).json({ error: "Radyo ozelligi kapali." });
  }
  next();
};

export const radioRestMount = (app) => {
  if (!app || typeof app.get !== "function") return;

  app.get("/api/radio/health", (_req, res) => {
    res.json({ enabled: isRadioEnabled(), activeSessions: radioSessions.size });
  });

  app.get("/api/radio/categories", featureFlagGuard, (_req, res) => {
    res.json({ categories: getCategories() });
  });

  app.get("/api/radio/stations", featureFlagGuard, (req, res) => {
    const { category } = req.query;
    const list = category ? getStationsByCategory(String(category)) : getAllStations();
    res.json({ stations: list });
  });

  app.get("/api/radio/state/:roomId", featureFlagGuard, (req, res) => {
    const roomId = req.params.roomId;
    for (const session of radioSessions.values()) {
      if (session.voiceRoomId.startsWith(`${roomId}-`)) {
        return res.json(buildRadioStatePayload(session));
      }
    }
    res.json(buildEmptyRadioStatePayload(roomId));
  });
};
