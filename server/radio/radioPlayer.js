// ffmpeg-based radio playback pipeline. Handles:
//   - HLS (.m3u8) and continuous MP3/AAC streams via ffmpeg network input
//   - PCM s16le 48kHz stereo pump to RTCAudioSource (10ms frames)
//   - Station switching (clean kill + fresh spawn)
//   - Auto-reconnect with exponential backoff (3 attempts)
//   - Clean shutdown
//
// This pipeline is intentionally independent from the music bot pipeline in
// server/index.js. No function from the music pipeline is imported or called.

import { spawn } from "child_process";
import fs from "fs";
import ffmpegPath from "ffmpeg-static";
import {
  AUDIO_SAMPLE_RATE,
  AUDIO_CHANNEL_COUNT,
  AUDIO_BITS_PER_SAMPLE,
  FRAME_DURATION_MS,
  FRAME_SAMPLES_PER_CHANNEL,
  FRAME_SIZE_BYTES,
  RADIO_PREBUFFER_FRAMES,
  RADIO_REBUFFER_FRAMES,
  RADIO_MAX_CATCHUP_FRAMES,
  SILENCE_SAMPLES
} from "./audioConstants.js";
import { logError, logInfo, logWarn } from "./logger.js";
import {
  ensureRadioBotConnectedToRoomUsers,
  getServerRoomIdFromVoiceRoomId
} from "./radioSession.js";
import { getAdapter } from "./adapter.js";

const MAX_RECONNECT_ATTEMPTS = 3;

// Resolve ffmpeg binary with a failsafe preference for the OS-provided build.
// The bundled ffmpeg-static (johnvansickle 7.0.2 static Linux) has been
// observed to segfault with empty stderr when reading network inputs
// (HLS/HTTPS) on modern glibc Ubuntu hosts — which is exactly what radio
// needs. The OS package is feature-complete for streaming and far more
// reliable there, so we prefer it when available. Music bot code is
// unaffected (it decodes local files where ffmpeg-static is fine).
const resolveRadioFfmpegBinary = () => {
  if (process.env.RADIO_FFMPEG_PATH) return process.env.RADIO_FFMPEG_PATH;
  if (process.env.FFMPEG_PATH) return process.env.FFMPEG_PATH;
  const systemCandidates = ["/usr/bin/ffmpeg", "/usr/local/bin/ffmpeg"];
  for (const candidate of systemCandidates) {
    try {
      if (fs.existsSync(candidate)) return candidate;
    } catch {
      /* ignore */
    }
  }
  return ffmpegPath || "ffmpeg";
};

const RADIO_FFMPEG_BIN = resolveRadioFfmpegBinary();

const buildRadioFfmpegArgs = ({ streamUrl, volume = 40, isMuted = false }) => {
  const effectiveVolume = isMuted ? 0 : Math.max(0, volume) / 100;
  return [
    "-loglevel", "error",
    "-nostdin",
    "-fflags", "+nobuffer+discardcorrupt",
    "-flags", "low_delay",
    "-reconnect", "1",
    "-reconnect_streamed", "1",
    "-reconnect_on_network_error", "1",
    "-reconnect_delay_max", "5",
    "-rw_timeout", "15000000",
    "-user_agent", "KomboRadio/1.0 (+https://kombogame.com)",
    "-i", streamUrl,
    "-vn", "-sn", "-dn",
    "-filter:a", `volume=${effectiveVolume}`,
    "-f", "s16le",
    "-ar", `${AUDIO_SAMPLE_RATE}`,
    "-ac", `${AUDIO_CHANNEL_COUNT}`,
    "pipe:1"
  ];
};

const pushSilenceFrame = (session) => {
  try {
    session.audioSource.onData({
      samples: SILENCE_SAMPLES,
      sampleRate: AUDIO_SAMPLE_RATE,
      bitsPerSample: AUDIO_BITS_PER_SAMPLE,
      channelCount: AUDIO_CHANNEL_COUNT,
      numberOfFrames: FRAME_SAMPLES_PER_CHANNEL
    });
  } catch {
    /* audio source may have been closed */
  }
};

const pumpChunk = (session, chunk) => {
  if (!chunk || chunk.length === 0) return;
  session.audioChunks.push(chunk);
  session.bufferedBytes += chunk.length;

  if (!session.hasPlaybackStarted) {
    const minBytes = FRAME_SIZE_BYTES * RADIO_PREBUFFER_FRAMES;
    if (session.bufferedBytes >= minBytes || session.sourceEnded) {
      session.hasPlaybackStarted = true;
    }
  }
  session.sentSilenceFrames = 0;
};

const flushOneFrame = (session) => {
  if (session.bufferedBytes < FRAME_SIZE_BYTES) return false;

  const frameData = Buffer.allocUnsafe(FRAME_SIZE_BYTES);
  let written = 0;

  while (written < FRAME_SIZE_BYTES && session.audioChunks.length > 0) {
    const head = session.audioChunks[0];
    const toCopy = Math.min(head.length, FRAME_SIZE_BYTES - written);
    head.copy(frameData, written, 0, toCopy);
    written += toCopy;
    if (toCopy === head.length) {
      session.audioChunks.shift();
    } else {
      session.audioChunks[0] = head.subarray(toCopy);
    }
  }

  session.bufferedBytes = Math.max(0, session.bufferedBytes - FRAME_SIZE_BYTES);

  if (written < FRAME_SIZE_BYTES) {
    // partial frame; discard
    session.audioChunks = [];
    session.bufferedBytes = 0;
    return false;
  }

  const ab = new ArrayBuffer(FRAME_SIZE_BYTES);
  new Uint8Array(ab).set(frameData);
  const samples = new Int16Array(ab);

  try {
    session.audioSource.onData({
      samples,
      sampleRate: AUDIO_SAMPLE_RATE,
      bitsPerSample: AUDIO_BITS_PER_SAMPLE,
      channelCount: AUDIO_CHANNEL_COUNT,
      numberOfFrames: FRAME_SAMPLES_PER_CHANNEL
    });
  } catch {
    return false;
  }
  return true;
};

const stopPlaybackTimer = (session) => {
  if (!session.playbackInterval) return;
  clearTimeout(session.playbackInterval);
  session.playbackInterval = null;
  session.nextPlaybackDueAt = 0;
};

const startPlaybackTimer = (session) => {
  // Idempotent: if a timer is already running, leave it in place so we do
  // not drop a tick while transitioning between idle/playing.
  if (session.playbackInterval) return;
  session.nextPlaybackDueAt = Date.now();

  const tick = () => {
    // Session disposed? stop entirely.
    if (!session.audioSource) {
      stopPlaybackTimer(session);
      return;
    }
    if (!session.hasPlaybackStarted) {
      // Pre-buffer or post-stop idle window: emit continuous 10ms silence
      // frames so the WebRTC sender keeps the outbound track "alive". If we
      // let the track go silent for longer than ~5s, some browsers treat
      // the track as ended and will not resume audio when real PCM resumes.
      pushSilenceFrame(session);
      session.nextPlaybackDueAt = Date.now() + FRAME_DURATION_MS;
      session.playbackInterval = setTimeout(tick, FRAME_DURATION_MS);
      return;
    }

    const now = Date.now();
    const behind = Math.max(0, now - session.nextPlaybackDueAt);
    const extra = Math.floor(behind / FRAME_DURATION_MS);
    const frames = Math.min(1 + extra, RADIO_MAX_CATCHUP_FRAMES);

    for (let i = 0; i < frames; i++) {
      if (session.isRebuffering) {
        const minBytes = FRAME_SIZE_BYTES * RADIO_REBUFFER_FRAMES;
        if (session.bufferedBytes < minBytes && !session.sourceEnded) break;
        session.isRebuffering = false;
      }

      const flushed = flushOneFrame(session);
      if (flushed) {
        if (session.status !== "playing") {
          session.status = "playing";
          emitRadioState(session, true);
        }
        session.sentSilenceFrames = 0;
      } else if (!session.sourceEnded) {
        session.sentSilenceFrames += 1;
        if (session.sentSilenceFrames >= 2) {
          session.sentSilenceFrames = 0;
          session.isRebuffering = true;
          break;
        }
        pushSilenceFrame(session);
      } else {
        // ffmpeg ended AND buffer is empty -> reconnect flow handled on close
        break;
      }

      session.nextPlaybackDueAt += FRAME_DURATION_MS;
    }

    const delay = Math.max(0, session.nextPlaybackDueAt - Date.now());
    session.playbackInterval = setTimeout(tick, delay);
  };

  session.playbackInterval = setTimeout(tick, FRAME_DURATION_MS);
};

export const emitRadioState = (session, force = false) => {
  const { io } = getAdapter();
  if (!session || !io) return;

  const now = Date.now();
  if (!force && now - (session.lastStateEmitAt || 0) < 250) return;
  session.lastStateEmitAt = now;

  const roomId = getServerRoomIdFromVoiceRoomId(session.voiceRoomId);
  if (!roomId) return;

  io.to(roomId).emit("radio-state", buildRadioStatePayload(session));
};

export const buildRadioStatePayload = (session) => {
  if (!session) return null;
  return {
    voiceRoomId: session.voiceRoomId,
    roomId: getServerRoomIdFromVoiceRoomId(session.voiceRoomId),
    status: session.status,
    station: session.station
      ? {
          id: session.station.id,
          name: session.station.name,
          category: session.station.category,
          homepage: session.station.homepage || ""
        }
      : null,
    volume: Number(session.volume || 0),
    isMuted: !!session.isMuted,
    retryCount: session.reconnect?.attempts || 0,
    error: session.lastError || null
  };
};

export const buildEmptyRadioStatePayload = (roomId) => ({
  voiceRoomId: "",
  roomId: roomId || "",
  status: "idle",
  station: null,
  volume: 0,
  isMuted: false,
  retryCount: 0,
  error: null
});

const clearReconnectTimer = (session) => {
  if (session.reconnect?.timer) {
    clearTimeout(session.reconnect.timer);
    session.reconnect.timer = null;
  }
};

const killFfmpeg = (session) => {
  if (!session.ffmpeg) return;
  const proc = session.ffmpeg;
  session.ffmpeg = null;
  try {
    proc.stdout?.removeAllListeners();
    proc.stderr?.removeAllListeners();
    proc.removeAllListeners("close");
    proc.removeAllListeners("error");
  } catch {
    /* noop */
  }
  try {
    proc.kill("SIGKILL");
  } catch {
    /* noop */
  }
};

const resetBuffers = (session) => {
  session.audioChunks = [];
  session.bufferedBytes = 0;
  session.hasPlaybackStarted = false;
  session.isRebuffering = false;
  session.sentSilenceFrames = 0;
  session.sourceEnded = false;
};

export const playStation = (session, station) => {
  if (!session) return;

  // Kill any previous pipeline before starting a new one.
  session.activePlaybackToken += 1;
  const token = session.activePlaybackToken;

  session.isStopping = false;
  clearReconnectTimer(session);
  killFfmpeg(session);
  resetBuffers(session);

  session.station = station;
  session.status = "connecting";
  session.lastError = null;
  session.reconnect.attempts = 0;

  emitRadioState(session, true);
  ensureRadioBotConnectedToRoomUsers(session);

  spawnFfmpegForCurrent(session, token);
  startPlaybackTimer(session);
};

const spawnFfmpegForCurrent = (session, token) => {
  const station = session.station;
  if (!station) return;

  const bin = RADIO_FFMPEG_BIN;
  const args = buildRadioFfmpegArgs({
    streamUrl: station.streamUrl,
    volume: session.volume,
    isMuted: session.isMuted
  });

  let proc;
  try {
    proc = spawn(bin, args, { stdio: ["ignore", "pipe", "pipe"] });
  } catch (err) {
    logError("radio_ffmpeg_spawn_failed", {
      roomId: getServerRoomIdFromVoiceRoomId(session.voiceRoomId),
      voiceRoomId: session.voiceRoomId,
      stationId: station.id,
      error: err?.message
    });
    scheduleReconnect(session, token, err?.message || "spawn_failed");
    return;
  }

  session.ffmpeg = proc;
  let stderrText = "";

  proc.stdout.on("data", (chunk) => {
    if (session.activePlaybackToken !== token) return;
    pumpChunk(session, chunk);
  });

  proc.stderr.on("data", (data) => {
    if (session.activePlaybackToken !== token) return;
    const msg = data.toString().trim();
    if (msg) {
      stderrText += `${msg}\n`;
      logWarn("radio_ffmpeg_stderr", {
        voiceRoomId: session.voiceRoomId,
        stationId: station.id,
        message: msg.slice(0, 400)
      });
    }
  });

  proc.on("error", (err) => {
    if (session.activePlaybackToken !== token) return;
    logError("radio_ffmpeg_error", {
      voiceRoomId: session.voiceRoomId,
      stationId: station.id,
      error: err?.message
    });
  });

  proc.on("close", (code) => {
    if (session.activePlaybackToken !== token) return;
    session.ffmpeg = null;
    session.sourceEnded = true;

    if (session.isStopping) {
      // Intentional stop; do nothing further.
      return;
    }

    logWarn("radio_ffmpeg_closed", {
      voiceRoomId: session.voiceRoomId,
      stationId: station.id,
      code,
      stderrTail: stderrText.split("\n").filter(Boolean).slice(-3).join(" | ")
    });

    scheduleReconnect(session, token, code === 0 ? "stream_ended" : `exit_${code}`);
  });
};

const scheduleReconnect = (session, token, reason) => {
  if (session.activePlaybackToken !== token) return;
  if (session.isStopping) return;

  if (session.reconnect.attempts >= MAX_RECONNECT_ATTEMPTS) {
    session.status = "error";
    session.lastError = `stream_failed:${reason}`;
    emitRadioState(session, true);

    const { sendSystemMessage } = getAdapter();
    const roomId = getServerRoomIdFromVoiceRoomId(session.voiceRoomId);
    if (typeof sendSystemMessage === "function" && roomId) {
      sendSystemMessage(
        roomId,
        `Radyo baglantisi kurulamadi (${session.station?.name || "istasyon"}). Lutfen daha sonra tekrar deneyin.`
      );
    }

    logError("radio_reconnect_exhausted", {
      voiceRoomId: session.voiceRoomId,
      stationId: session.station?.id,
      reason
    });
    return;
  }

  session.reconnect.attempts += 1;
  session.status = "reconnecting";
  emitRadioState(session, true);

  const base = 500 * Math.pow(2, session.reconnect.attempts - 1);
  const jitter = Math.floor(Math.random() * 250);
  const delay = Math.min(4000, base) + jitter;

  logInfo("radio_reconnect_scheduled", {
    voiceRoomId: session.voiceRoomId,
    stationId: session.station?.id,
    attempt: session.reconnect.attempts,
    delayMs: delay,
    reason
  });

  session.reconnect.timer = setTimeout(() => {
    if (session.activePlaybackToken !== token) return;
    if (session.isStopping) return;
    resetBuffers(session);
    spawnFfmpegForCurrent(session, token);
  }, delay);
};

export const stopStation = (session) => {
  if (!session) return;
  session.isStopping = true;
  session.status = "idle";
  session.activePlaybackToken += 1;
  clearReconnectTimer(session);
  killFfmpeg(session);
  resetBuffers(session);
  session.station = null;
  session.lastError = null;
  session.reconnect.attempts = 0;
  // Keep the playback timer running so continuous silence frames maintain
  // the WebRTC outbound audio track; a new playStation() on this session
  // will then produce audio ~instantly without a fresh peer negotiation.
  startPlaybackTimer(session);
  emitRadioState(session, true);
};

export const applyVolume = (session, nextVolume) => {
  const v = Math.max(0, Math.min(200, Number(nextVolume)));
  if (!Number.isFinite(v)) return;
  session.volume = v;
  // Cheapest path: respawn ffmpeg with new volume filter only if currently playing.
  if (session.station && !session.isStopping) {
    const token = session.activePlaybackToken + 1;
    session.activePlaybackToken = token;
    clearReconnectTimer(session);
    killFfmpeg(session);
    resetBuffers(session);
    spawnFfmpegForCurrent(session, token);
  }
  emitRadioState(session, true);
};

export const setMuted = (session, muted) => {
  const next = !!muted;
  if (session.isMuted === next) return;
  if (next) session.prevVolume = session.volume;
  session.isMuted = next;
  if (session.station && !session.isStopping) {
    const token = session.activePlaybackToken + 1;
    session.activePlaybackToken = token;
    clearReconnectTimer(session);
    killFfmpeg(session);
    resetBuffers(session);
    spawnFfmpegForCurrent(session, token);
  }
  emitRadioState(session, true);
};

export const radioPlayerExports = {
  buildRadioFfmpegArgs,
  ffmpegBin: RADIO_FFMPEG_BIN,
  resolveRadioFfmpegBinary
};
