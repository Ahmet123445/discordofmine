// Per-voiceRoom radio session state + lifecycle.
// Kept intentionally independent from the music session map in server/index.js.

import wrtc from "@roamhq/wrtc";
import Peer from "simple-peer";
import { getAdapter } from "./adapter.js";
import { RADIO_BOT_USERNAME } from "./audioConstants.js";
import { logInfo, logWarn } from "./logger.js";
import { applyRadioAudioPreferences } from "./sdpHelpers.js";

export const radioSessions = new Map(); // voiceRoomId -> RadioSession
const RADIO_PEER_RECONNECT_DELAYS_MS = [500, 1500, 3000, 5000];

export const buildRadioBotId = (voiceRoomId) => `radio-bot:${voiceRoomId}`;
export const isRadioBotId = (id) =>
  typeof id === "string" && id.startsWith("radio-bot:");

export const getServerRoomIdFromVoiceRoomId = (voiceRoomId = "") => {
  const lastDash = voiceRoomId.lastIndexOf("-");
  return lastDash > 0 ? voiceRoomId.substring(0, lastDash) : "";
};

const addRadioBotPresence = (voiceRoomId) => {
  const { usersInVoice, broadcastAllVoiceUsers } = getAdapter();
  const botId = buildRadioBotId(voiceRoomId);
  if (!usersInVoice[voiceRoomId]) usersInVoice[voiceRoomId] = [];
  const exists = usersInVoice[voiceRoomId].some((u) => u.id === botId);
  if (!exists) {
    usersInVoice[voiceRoomId].push({ id: botId, username: RADIO_BOT_USERNAME });
    if (typeof broadcastAllVoiceUsers === "function") broadcastAllVoiceUsers();
  }
  return botId;
};

const removeRadioBotPresence = (voiceRoomId) => {
  const { usersInVoice, broadcastAllVoiceUsers } = getAdapter();
  const botId = buildRadioBotId(voiceRoomId);
  const roomUsers = usersInVoice?.[voiceRoomId];
  if (!roomUsers) return;

  const idx = roomUsers.findIndex((u) => u.id === botId);
  if (idx !== -1) roomUsers.splice(idx, 1);

  if (roomUsers.length === 0) delete usersInVoice[voiceRoomId];
  if (typeof broadcastAllVoiceUsers === "function") broadcastAllVoiceUsers();
};

const getHumanVoiceUsers = (voiceRoomId) => {
  const { usersInVoice, musicSessions } = getAdapter();
  const raw = usersInVoice?.[voiceRoomId] || [];
  return raw.filter((u) => {
    if (isRadioBotId(u.id)) return false;
    // Music bot ids use "music-bot:" prefix in server/index.js.
    if (typeof u.id === "string" && u.id.startsWith("music-bot:")) return false;
    return true;
  });
};

export const createRadioSession = (voiceRoomId) => {
  if (radioSessions.has(voiceRoomId)) return radioSessions.get(voiceRoomId);

  const RTC = wrtc.default || wrtc;
  const audioSource = new RTC.nonstandard.RTCAudioSource();
  const track = audioSource.createTrack();
  const stream = new RTC.MediaStream([track]);
  const botId = addRadioBotPresence(voiceRoomId);

  const session = {
    voiceRoomId,
    botId,
    audioSource,
    track,
    stream,
    peers: new Map(),
    station: null,
    ffmpeg: null,
    activePlaybackToken: 0,
    audioChunks: [],
    bufferedBytes: 0,
    hasPlaybackStarted: false,
    sentSilenceFrames: 0,
    isRebuffering: false,
    sourceEnded: false,
    playbackInterval: null,
    nextPlaybackDueAt: 0,
    volume: Math.max(0, Math.min(200, Number(process.env.RADIO_DEFAULT_VOLUME) || 40)),
    isMuted: false,
    prevVolume: 40,
    isStopping: false,
    reconnect: { attempts: 0, timer: null },
    status: "idle", // idle | connecting | playing | reconnecting | error | stopping
    lastError: null,
    createdAt: Date.now(),
    lastStateEmitAt: 0,
    peerReconnectTimers: new Map(),
    peerReconnectAttempts: new Map()
  };

  radioSessions.set(voiceRoomId, session);
  logInfo("radio_session_created", { voiceRoomId, botId });
  return session;
};

export const connectRadioBotToUser = (session, userSocketId, { replacePeer = false } = {}) => {
  const { io, ICE_SERVERS } = getAdapter();
  if (!io || !session) return;
  if (!io.sockets.sockets.get(userSocketId)) return;
  addRadioBotPresence(session.voiceRoomId);
  if (session.peers.has(userSocketId)) {
    const existingPeer = session.peers.get(userSocketId);
    if (!replacePeer && isRadioPeerUsable(existingPeer)) return;
    destroyRadioPeer(session, userSocketId);
    replacePeer = true;
  }

  const RTC = wrtc.default || wrtc;
  const peer = new Peer({
    initiator: true,
    trickle: true,
    stream: session.stream,
    wrtc: RTC,
    config: { iceServers: ICE_SERVERS || [] },
    sdpTransform: (sdp) => applyRadioAudioPreferences(sdp)
  });

  let shouldReplaceOnOffer = replacePeer;
  peer.on("signal", (signal) => {
    const replaceThisSignal = shouldReplaceOnOffer && signal?.type === "offer";
    if (replaceThisSignal) {
      shouldReplaceOnOffer = false;
    }

    io.to(userSocketId).emit("user-joined-voice", {
      signal,
      callerID: session.botId,
      username: RADIO_BOT_USERNAME,
      replacePeer: replaceThisSignal
    });
  });

  peer.on("connect", () => {
    clearRadioPeerReconnect(session, userSocketId);
    logInfo("radio_peer_connected", { voiceRoomId: session.voiceRoomId, userSocketId });
  });

  peer.on("error", (err) => {
    logWarn("radio_peer_error", {
      voiceRoomId: session.voiceRoomId,
      userSocketId,
      error: err?.message
    });
    handleRadioPeerLoss(session, userSocketId, err?.message || "peer error");
  });

  peer.on("close", () => {
    if (peer.__intentionalDestroy) return;
    handleRadioPeerLoss(session, userSocketId, "peer close");
  });

  session.peers.set(userSocketId, peer);
};

const isRadioPeerUsable = (peer) => {
  if (!peer || peer.destroyed) return false;
  const pc = peer._pc;
  if (!pc) return true;

  return !["closed", "failed", "disconnected"].includes(pc.connectionState) &&
    !["closed", "failed", "disconnected"].includes(pc.iceConnectionState);
};

const clearRadioPeerReconnect = (session, userSocketId) => {
  if (!session) return;
  const timer = session.peerReconnectTimers?.get(userSocketId);
  if (timer) clearTimeout(timer);
  session.peerReconnectTimers?.delete(userSocketId);
  session.peerReconnectAttempts?.delete(userSocketId);
};

const isRadioPeerReconnectEligible = (session, userSocketId) => {
  const { io } = getAdapter();
  if (!session || radioSessions.get(session.voiceRoomId) !== session) return false;
  if (!io?.sockets?.sockets?.get(userSocketId)) return false;
  return getHumanVoiceUsers(session.voiceRoomId).some((u) => u.id === userSocketId);
};

const scheduleRadioPeerReconnect = (session, userSocketId, reason) => {
  if (!isRadioPeerReconnectEligible(session, userSocketId)) {
    logInfo("radio_peer_reconnect_skipped", { voiceRoomId: session?.voiceRoomId, userSocketId, reason });
    clearRadioPeerReconnect(session, userSocketId);
    return;
  }

  if (session.peerReconnectTimers.has(userSocketId)) return;

  const attempt = (session.peerReconnectAttempts.get(userSocketId) || 0) + 1;
  const delayMs = RADIO_PEER_RECONNECT_DELAYS_MS[Math.min(attempt - 1, RADIO_PEER_RECONNECT_DELAYS_MS.length - 1)];
  session.peerReconnectAttempts.set(userSocketId, attempt);
  logWarn("radio_peer_reconnect_scheduled", { voiceRoomId: session.voiceRoomId, userSocketId, attempt, delayMs, reason });

  const timer = setTimeout(() => {
    session.peerReconnectTimers.delete(userSocketId);
    if (!isRadioPeerReconnectEligible(session, userSocketId)) {
      logInfo("radio_peer_reconnect_skipped", { voiceRoomId: session.voiceRoomId, userSocketId, reason: "no_longer_in_voice" });
      clearRadioPeerReconnect(session, userSocketId);
      return;
    }

    logInfo("radio_peer_reconnect_attempt", { voiceRoomId: session.voiceRoomId, userSocketId, attempt });
    connectRadioBotToUser(session, userSocketId, { replacePeer: true });
  }, delayMs);

  session.peerReconnectTimers.set(userSocketId, timer);
};

const handleRadioPeerLoss = (session, userSocketId, reason) => {
  destroyRadioPeer(session, userSocketId, { allowReconnect: true });
  scheduleRadioPeerReconnect(session, userSocketId, reason);
};

export const ensureRadioBotConnectedToRoomUsers = (session) => {
  const users = getHumanVoiceUsers(session.voiceRoomId);
  users.forEach((u) => connectRadioBotToUser(session, u.id));
};

export const destroyRadioPeer = (session, userSocketId, { allowReconnect = false } = {}) => {
  const peer = session.peers.get(userSocketId);
  if (!allowReconnect) {
    clearRadioPeerReconnect(session, userSocketId);
  }
  if (!peer) return;

  peer.__intentionalDestroy = !allowReconnect;
  try {
    peer.destroy();
  } catch {
    /* noop */
  }
  session.peers.delete(userSocketId);
};

export const destroyAllRadioPeers = (session) => {
  for (const id of Array.from(session.peers.keys())) {
    destroyRadioPeer(session, id);
  }
};

export const disposeRadioSession = (voiceRoomId) => {
  const session = radioSessions.get(voiceRoomId);
  if (!session) return;

  // Stop the silence-pump playback timer before we clear audioSource; the
  // tick guard checks session.audioSource so this ordering is important.
  try {
    if (session.playbackInterval) {
      clearTimeout(session.playbackInterval);
      session.playbackInterval = null;
    }
  } catch {
    /* noop */
  }

  try {
    destroyAllRadioPeers(session);
  } catch {
    /* noop */
  }

  try {
    session.peerReconnectTimers?.forEach((timer) => clearTimeout(timer));
    session.peerReconnectTimers?.clear();
    session.peerReconnectAttempts?.clear();
  } catch {
    /* noop */
  }

  try {
    if (session.track && typeof session.track.stop === "function") session.track.stop();
  } catch {
    /* noop */
  }

  try {
    if (session.audioSource && typeof session.audioSource.close === "function") {
      session.audioSource.close();
    }
    session.audioSource = null;
  } catch {
    /* noop */
  }

  radioSessions.delete(voiceRoomId);
  removeRadioBotPresence(voiceRoomId);
  logInfo("radio_session_disposed", { voiceRoomId });
};

export { getHumanVoiceUsers as getHumanRadioRoomUsers };
