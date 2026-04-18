// Loads, validates and indexes the station catalog from stations.json.
// Acts as the security allowlist: only URLs present here are playable.

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { logError, logWarn, logInfo } from "./logger.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const SUPPORTED_CATEGORIES = new Set([
  "pop",
  "turkce-pop",
  "arabesk",
  "haber",
  "ekonomi",
  "talk"
]);

const REQUIRED_FIELDS = ["id", "name", "category", "streamUrl"];

let stations = [];
let byId = new Map();
let urlAllowlist = new Set();

const isValidHttpUrl = (value) => {
  if (typeof value !== "string" || value.length === 0) return false;
  try {
    const u = new URL(value);
    return u.protocol === "http:" || u.protocol === "https:";
  } catch {
    return false;
  }
};

const validateStation = (raw) => {
  for (const field of REQUIRED_FIELDS) {
    if (!raw || typeof raw[field] !== "string" || raw[field].trim() === "") {
      return { ok: false, reason: `missing_field:${field}` };
    }
  }
  if (!SUPPORTED_CATEGORIES.has(raw.category)) {
    return { ok: false, reason: `unsupported_category:${raw.category}` };
  }
  if (!isValidHttpUrl(raw.streamUrl)) {
    return { ok: false, reason: "invalid_stream_url" };
  }
  return { ok: true };
};

export const loadStations = (filePath = path.join(__dirname, "stations.json")) => {
  try {
    const raw = fs.readFileSync(filePath, "utf8");
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) {
      throw new Error("stations.json root must be an array");
    }

    const next = [];
    for (const item of parsed) {
      const { ok, reason } = validateStation(item);
      if (!ok) {
        logWarn("station_rejected", { id: item?.id, reason });
        continue;
      }
      next.push({
        id: item.id,
        name: item.name,
        category: item.category,
        city: item.city || "",
        country: item.country || "",
        streamUrl: item.streamUrl,
        homepage: item.homepage || "",
        enabled: item.enabled !== false,
        priority: Number(item.priority) || 0
      });
    }

    next.sort((a, b) => b.priority - a.priority);
    stations = next;
    byId = new Map(stations.map((s) => [s.id, s]));
    urlAllowlist = new Set(stations.map((s) => s.streamUrl));
    logInfo("stations_loaded", { count: stations.length });
    return stations;
  } catch (err) {
    logError("stations_load_failed", { error: err?.message });
    stations = [];
    byId = new Map();
    urlAllowlist = new Set();
    return stations;
  }
};

export const getAllStations = ({ enabledOnly = true } = {}) => {
  return stations.filter((s) => (enabledOnly ? s.enabled : true));
};

export const getStationsByCategory = (category, { enabledOnly = true } = {}) => {
  const all = getAllStations({ enabledOnly });
  if (!category) return all;
  return all.filter((s) => s.category === category);
};

export const getStationById = (id) => byId.get(id) || null;

export const isAllowedStreamUrl = (url) => urlAllowlist.has(url);

export const getCategories = () => Array.from(SUPPORTED_CATEGORIES);

export const getStationsOrdered = ({ enabledOnly = true } = {}) => {
  // already sorted by priority desc at load time
  return getAllStations({ enabledOnly });
};

// Auto-load on import so REST/command handlers work out of the box.
loadStations();
