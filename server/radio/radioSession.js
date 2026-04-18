// Per-voiceRoom radio session state + lifecycle.
// Kept intentionally independent from the music session map in server/index.js.

import wrtc from "@roamhq/wrtc";
import Peer from "simple-peer";
import { getAdapter } from "./adapter.js";
import { RADIO_BOT_USERNAME } from "./audioConstants.js";
import { logInfo, logWarn } from "./logger.js";

export const radioSessions = new Map(); // voiceRoomId -> RadioSession

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
    lastStateEmitAt: 0
  };

  radioSessions.set(voiceRoomId, session);
  logInfo("radio_session_created", { voiceRoomId, botId });
  return session;
};

export const connectRadioBotToUser = (session, userSocketId) => {
  const { io, ICE_SERVERS } = getAdapter();
  if (!io || !session) return;
  if (!io.sockets.sockets.get(userSocketId)) return;
  if (session.peers.has(userSocketId)) return;

  const RTC = wrtc.default || wrtc;
  const peer = new Peer({
    initiator: true,
    trickle: true,
    stream: session.stream,
    wrtc: RTC,
    config: { iceServers: ICE_SERVERS || [] }
  });

  peer.on("signal", (signal) => {
    io.to(userSocketId).emit("user-joined-voice", {
      signal,
      callerID: session.botId,
      username: RADIO_BOT_USERNAME
    });
  });

  peer.on("error", (err) => {
    logWarn("radio_peer_error", {
      voiceRoomId: session.voiceRoomId,
      userSocketId,
      error: err?.message
    });
    destroyRadioPeer(session, userSocketId);
  });

  peer.on("close", () => destroyRadioPeer(session, userSocketId));

  session.peers.set(userSocketId, peer);
};

export const ensureRadioBotConnectedToRoomUsers = (session) => {
  const users = getHumanVoiceUsers(session.voiceRoomId);
  users.forEach((u) => connectRadioBotToUser(session, u.id));
};

export const destroyRadioPeer = (session, userSocketId) => {
  const peer = session.peers.get(userSocketId);
  if (!peer) return;
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

  try {
    destroyAllRadioPeers(session);
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
  } catch {
    /* noop */
  }

  radioSessions.delete(voiceRoomId);
  removeRadioBotPresence(voiceRoomId);
  logInfo("radio_session_disposed", { voiceRoomId });
};

export { getHumanVoiceUsers as getHumanRadioRoomUsers };
