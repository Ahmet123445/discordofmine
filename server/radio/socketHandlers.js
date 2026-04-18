// socket.io event wiring for the radio module. Registered via attachRadioSockets
// at init time. Uses parallel handlers on 'connection' / 'disconnect' /
// 'join-voice' / 'leave-voice' so server/index.js does not have to add them.

import { getAdapter, isRadioEnabled } from "./adapter.js";
import {
  radioSessions,
  createRadioSession,
  connectRadioBotToUser,
  destroyRadioPeer,
  disposeRadioSession,
  isRadioBotId,
  getServerRoomIdFromVoiceRoomId,
  getHumanRadioRoomUsers
} from "./radioSession.js";
import {
  playStation,
  stopStation,
  applyVolume,
  setMuted,
  emitRadioState,
  buildRadioStatePayload,
  buildEmptyRadioStatePayload
} from "./radioPlayer.js";
import { getStationById, getStationsOrdered } from "./stationRegistry.js";
import { canStartRadio } from "./radioConflict.js";
import { logInfo, logWarn } from "./logger.js";

// roomId -> voiceRoomId tracking (mirror of socketToRoom in host; keyed by socket)
const socketToVoiceRoom = new Map();
const socketToTextRoom = new Map();

const findRadioSessionByServerRoomId = (roomId) => {
  for (const session of radioSessions.values()) {
    if (getServerRoomIdFromVoiceRoomId(session.voiceRoomId) === roomId) {
      return session;
    }
  }
  return null;
};

const maybeAutoStopRadioForRoom = (voiceRoomId) => {
  const session = radioSessions.get(voiceRoomId);
  if (!session) return;
  const humans = getHumanRadioRoomUsers(voiceRoomId);
  if (humans.length === 0) {
    stopStation(session);
    disposeRadioSession(voiceRoomId);
    const { sendSystemMessage } = getAdapter();
    const roomId = getServerRoomIdFromVoiceRoomId(voiceRoomId);
    if (typeof sendSystemMessage === "function" && roomId) {
      sendSystemMessage(roomId, "Radyo odada kimse kalmadigi icin kapatildi.");
    }
  }
};

export const attachRadioSockets = () => {
  if (!isRadioEnabled()) return;
  const { io } = getAdapter();
  if (!io) return;

  io.on("connection", (socket) => {
    if (!isRadioEnabled()) return;

    socket.on("radio-control", (payload = {}) => handleRadioControl(socket, payload));

    socket.on("join-voice", (data) => {
      const roomId = typeof data === "object" ? data?.roomId : data;
      if (!roomId) return;
      socketToVoiceRoom.set(socket.id, roomId);
      // If a radio session exists for this voiceRoomId, connect the new user.
      const session = radioSessions.get(roomId);
      if (session) {
        connectRadioBotToUser(session, socket.id);
        emitRadioState(session, true);
      }
    });

    socket.on("leave-voice", () => {
      const roomId = socketToVoiceRoom.get(socket.id);
      socketToVoiceRoom.delete(socket.id);
      if (!roomId) return;
      const session = radioSessions.get(roomId);
      if (session) destroyRadioPeer(session, socket.id);
      maybeAutoStopRadioForRoom(roomId);
    });

    socket.on("join-room", (data) => {
      const roomId = typeof data === "object" ? data?.roomId : data;
      if (!roomId) return;
      socketToTextRoom.set(socket.id, roomId);
      const session = findRadioSessionByServerRoomId(roomId);
      socket.emit(
        "radio-state",
        session ? buildRadioStatePayload(session) : buildEmptyRadioStatePayload(roomId)
      );
    });

    // Fallback signaling support for the radio bot peer.
    socket.on("sending-signal", (payload = {}) => {
      if (!isRadioBotId(payload.userToSignal)) return;
      const voiceRoomId = socketToVoiceRoom.get(socket.id);
      const session = voiceRoomId ? radioSessions.get(voiceRoomId) : null;
      if (!session) return;
      // Server-side answerer peer path: build peer if missing
      // (initiator path is already handled in connectRadioBotToUser)
      const peer = session.peers.get(socket.id);
      if (peer) {
        try {
          peer.signal(payload.signal);
        } catch {
          /* noop */
        }
      }
    });

    socket.on("returning-signal", (payload = {}) => {
      if (!isRadioBotId(payload.callerID)) return;
      const voiceRoomId = socketToVoiceRoom.get(socket.id);
      const session = voiceRoomId ? radioSessions.get(voiceRoomId) : null;
      if (!session) return;
      const peer = session.peers.get(socket.id);
      if (peer) {
        try {
          peer.signal(payload.signal);
        } catch {
          /* noop */
        }
      }
    });

    socket.on("disconnect", () => {
      const voiceRoomId = socketToVoiceRoom.get(socket.id);
      socketToVoiceRoom.delete(socket.id);
      socketToTextRoom.delete(socket.id);
      if (!voiceRoomId) return;
      const session = radioSessions.get(voiceRoomId);
      if (session) destroyRadioPeer(session, socket.id);
      maybeAutoStopRadioForRoom(voiceRoomId);
    });
  });

  logInfo("radio_sockets_attached", {});
};

const handleRadioControl = (socket, payload) => {
  if (!isRadioEnabled()) {
    socket.emit("radio-control-error", { error: "Radyo ozelligi kapali." });
    return;
  }

  const roomId = typeof payload.roomId === "string" ? payload.roomId : "";
  const action = typeof payload.action === "string" ? payload.action : "";
  if (!roomId || !action) {
    socket.emit("radio-control-error", { error: "Eksik parametre." });
    return;
  }

  const voiceRoomId = socketToVoiceRoom.get(socket.id);
  if (!voiceRoomId || !voiceRoomId.startsWith(`${roomId}-`)) {
    socket.emit("radio-control-error", {
      error: "Radyo kontrolu icin once odanin voice kanalina katilmalisin."
    });
    return;
  }

  const existing = radioSessions.get(voiceRoomId);

  try {
    if (action === "play") {
      const stationId = typeof payload.stationId === "string" ? payload.stationId : "";
      const station = getStationById(stationId);
      if (!station || !station.enabled) {
        socket.emit("radio-control-error", { error: `Bilinmeyen istasyon: ${stationId}` });
        return;
      }

      if (existing && existing.station && existing.station.id === station.id) {
        emitRadioState(existing, true);
        return;
      }

      if (!existing) {
        const conflict = canStartRadio(voiceRoomId);
        if (!conflict.ok) {
          socket.emit("radio-control-error", { error: conflict.message });
          return;
        }
      } else {
        const conflict = canStartRadio(voiceRoomId);
        if (!conflict.ok && conflict.reason === "music_active") {
          socket.emit("radio-control-error", { error: conflict.message });
          return;
        }
      }

      const session = existing || createRadioSession(voiceRoomId);
      playStation(session, station);
      logInfo("radio_socket_play", {
        voiceRoomId,
        roomId,
        stationId: station.id,
        stationName: station.name,
        streamUrl: station.streamUrl,
        eventType: "socket"
      });
      return;
    }

    if (action === "stop") {
      if (!existing) {
        socket.emit("radio-control-error", { error: "Aktif radyo yok." });
        return;
      }
      stopStation(existing);
      disposeRadioSession(voiceRoomId);
      logInfo("radio_socket_stop", { voiceRoomId, roomId, eventType: "socket" });
      return;
    }

    if (action === "next" || action === "prev") {
      if (!existing) {
        socket.emit("radio-control-error", { error: "Aktif radyo yok." });
        return;
      }
      const list = getStationsOrdered();
      if (!list.length) return;
      const idx = list.findIndex((s) => s.id === existing.station?.id);
      const nextIdx = action === "next"
        ? ((idx === -1 ? 0 : idx + 1) % list.length)
        : ((idx === -1 ? 0 : idx - 1 + list.length) % list.length);
      playStation(existing, list[nextIdx]);
      return;
    }

    if (action === "volume") {
      if (!existing) {
        socket.emit("radio-control-error", { error: "Aktif radyo yok." });
        return;
      }
      const v = Number(payload.value);
      if (!Number.isFinite(v) || v < 0 || v > 200) {
        socket.emit("radio-control-error", { error: "Ses 0-200 arasinda olmali." });
        return;
      }
      applyVolume(existing, v);
      return;
    }

    if (action === "mute" || action === "unmute") {
      if (!existing) {
        socket.emit("radio-control-error", { error: "Aktif radyo yok." });
        return;
      }
      setMuted(existing, action === "mute");
      return;
    }

    socket.emit("radio-control-error", { error: `Desteklenmeyen aksiyon: ${action}` });
  } catch (err) {
    logWarn("radio_control_error", { error: err?.message, action });
    socket.emit("radio-control-error", { error: "Radyo kontrolu sirasinda hata." });
  }
};
