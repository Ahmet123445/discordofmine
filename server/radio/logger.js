// Structured single-line JSON logger for the radio module.
// Never throws; safe to call from hot paths.

const LEVELS = { error: 40, warn: 30, info: 20, debug: 10 };
const MIN_LEVEL = LEVELS[(process.env.RADIO_LOG_LEVEL || "info").toLowerCase()] || LEVELS.info;

const emit = (level, message, context = {}) => {
  const lvlNum = LEVELS[level] || LEVELS.info;
  if (lvlNum < MIN_LEVEL) return;
  const payload = {
    ts: new Date().toISOString(),
    level,
    module: "radio",
    msg: message,
    ...context
  };
  try {
    const line = JSON.stringify(payload);
    if (level === "error") console.error(line);
    else if (level === "warn") console.warn(line);
    else console.log(line);
  } catch {
    console.log(`[radio] ${level} ${message}`);
  }
};

export const logInfo = (message, context) => emit("info", message, context);
export const logWarn = (message, context) => emit("warn", message, context);
export const logError = (message, context) => emit("error", message, context);
export const logDebug = (message, context) => emit("debug", message, context);
