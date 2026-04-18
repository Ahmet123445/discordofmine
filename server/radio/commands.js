// Slash command handler for /radio <subcommand>. Called from server/index.js
// via radioCommandHandler. Returns true when it has handled the command.

import { getAdapter, isRadioEnabled } from "./adapter.js";
import {
  createRadioSession,
  radioSessions,
  disposeRadioSession,
  ensureRadioBotConnectedToRoomUsers
} from "./radioSession.js";
import {
  playStation,
  stopStation,
  applyVolume,
  setMuted,
  emitRadioState
} from "./radioPlayer.js";
import {
  getAllStations,
  getStationById,
  getStationsByCategory,
  getStationsOrdered
} from "./stationRegistry.js";
import { canStartRadio } from "./radioConflict.js";
import { logInfo } from "./logger.js";

const sendSys = (roomId, content) => {
  const { sendSystemMessage } = getAdapter();
  if (typeof sendSystemMessage === "function") sendSystemMessage(roomId, content);
};

const getRadioHelpText = () =>
  [
    "Radyo komutlari:",
    "/radio list [kategori]   - Istasyonlari listele",
    "/radio play <id>         - Istasyon baslat",
    "/radio stop              - Radyoyu durdur",
    "/radio next              - Sonraki istasyon",
    "/radio prev              - Onceki istasyon",
    "/radio volume <0-200>    - Ses seviyesi",
    "/radio mute | unmute     - Sessize al / ac",
    "/radio nowplaying        - Simdi calan",
    "Kategoriler: pop, turkce-pop, arabesk, haber, ekonomi, talk"
  ].join("\n");

const findNeighborStation = (session, direction) => {
  const list = getStationsOrdered();
  if (list.length === 0) return null;
  if (!session?.station) return list[0];
  const idx = list.findIndex((s) => s.id === session.station.id);
  if (idx === -1) return list[0];
  const nextIdx = direction === "next"
    ? (idx + 1) % list.length
    : (idx - 1 + list.length) % list.length;
  return list[nextIdx];
};

const startStationInRoom = (voiceRoomId, roomId, station) => {
  const conflict = canStartRadio(voiceRoomId);
  if (!conflict.ok) {
    sendSys(roomId, conflict.message);
    return false;
  }

  const session = createRadioSession(voiceRoomId);
  ensureRadioBotConnectedToRoomUsers(session);
  playStation(session, station);
  sendSys(roomId, `Radyo baslatildi: ${station.name} (${station.category}).`);
  logInfo("radio_command_play", {
    voiceRoomId,
    roomId,
    stationId: station.id,
    stationName: station.name,
    streamUrl: station.streamUrl,
    eventType: "command"
  });
  return true;
};

export const handleRadioCommand = async ({
  roomId,
  commandText,
  voiceRoomId
}) => {
  if (!isRadioEnabled()) return false;

  const trimmed = (commandText || "").trim();
  if (!trimmed.toLowerCase().startsWith("/radio")) return false;

  const parts = trimmed.split(/\s+/);
  const sub = (parts[1] || "").toLowerCase();
  const args = parts.slice(2);

  // /radio (no sub) -> help
  if (!sub || sub === "help") {
    sendSys(roomId, getRadioHelpText());
    return true;
  }

  if (sub === "list") {
    const category = args[0];
    const list = category ? getStationsByCategory(category) : getAllStations();
    if (list.length === 0) {
      sendSys(roomId, category ? `Bu kategori icin istasyon yok: ${category}` : "Istasyon listesi bos.");
      return true;
    }
    const lines = list.map(
      (s, i) => `${i + 1}. [${s.id}] ${s.name} (${s.category})`
    );
    sendSys(roomId, `Radyo istasyonlari:\n${lines.join("\n")}`);
    return true;
  }

  // All remaining commands require the user to be in this room's voice channel.
  if (!voiceRoomId) {
    sendSys(roomId, "Radyo komutlari icin once bu odanin voice kanalina katilmalisin.");
    return true;
  }
  if (!voiceRoomId.startsWith(`${roomId}-`)) {
    sendSys(roomId, "Radyo komutu sadece bulundugun odanin voice kanalinda calisir.");
    return true;
  }

  const session = radioSessions.get(voiceRoomId);

  if (sub === "play") {
    const id = (args[0] || "").trim();
    if (!id) {
      sendSys(roomId, "Kullanim: /radio play <istasyon-id>. Liste: /radio list");
      return true;
    }
    const station = getStationById(id);
    if (!station || !station.enabled) {
      sendSys(roomId, `Bilinmeyen veya devre disi istasyon: ${id}. /radio list ile bakabilirsin.`);
      return true;
    }

    if (session && session.station && session.station.id === station.id) {
      sendSys(roomId, `Zaten caliyor: ${station.name}.`);
      return true;
    }

    if (session) {
      // Same room, different station -> clean switch without full teardown.
      const conflictCheck = canStartRadio(voiceRoomId);
      // Re-check only for music conflict; radio_already_active is fine here since
      // we are the one owning it.
      if (!conflictCheck.ok && conflictCheck.reason === "music_active") {
        sendSys(roomId, conflictCheck.message);
        return true;
      }
      playStation(session, station);
      sendSys(roomId, `Istasyon degistirildi: ${station.name} (${station.category}).`);
      logInfo("radio_command_switch", {
        voiceRoomId,
        roomId,
        stationId: station.id,
        stationName: station.name,
        streamUrl: station.streamUrl,
        eventType: "command"
      });
      return true;
    }

    startStationInRoom(voiceRoomId, roomId, station);
    return true;
  }

  if (sub === "stop") {
    if (!session) {
      sendSys(roomId, "Aktif radyo yok.");
      return true;
    }
    stopStation(session);
    disposeRadioSession(voiceRoomId);
    sendSys(roomId, "Radyo durduruldu.");
    logInfo("radio_command_stop", { voiceRoomId, roomId, eventType: "command" });
    return true;
  }

  if (sub === "next" || sub === "prev") {
    if (!session) {
      sendSys(roomId, "Once bir istasyon baslatmalisin: /radio play <id>.");
      return true;
    }
    const neighbor = findNeighborStation(session, sub);
    if (!neighbor) {
      sendSys(roomId, "Istasyon listesi bos.");
      return true;
    }
    playStation(session, neighbor);
    sendSys(roomId, `Istasyon: ${neighbor.name} (${neighbor.category}).`);
    return true;
  }

  if (sub === "volume") {
    if (!session) {
      sendSys(roomId, "Aktif radyo yok.");
      return true;
    }
    const raw = Number(args[0]);
    if (!Number.isFinite(raw) || raw < 0 || raw > 200) {
      sendSys(roomId, "Kullanim: /radio volume <0-200>");
      return true;
    }
    applyVolume(session, raw);
    sendSys(roomId, `Radyo ses seviyesi: ${raw}%`);
    return true;
  }

  if (sub === "mute") {
    if (!session) {
      sendSys(roomId, "Aktif radyo yok.");
      return true;
    }
    setMuted(session, true);
    sendSys(roomId, "Radyo sessize alindi.");
    return true;
  }

  if (sub === "unmute") {
    if (!session) {
      sendSys(roomId, "Aktif radyo yok.");
      return true;
    }
    setMuted(session, false);
    sendSys(roomId, "Radyo sesi acildi.");
    return true;
  }

  if (sub === "nowplaying" || sub === "np") {
    if (!session || !session.station) {
      sendSys(roomId, "Aktif radyo yok.");
      return true;
    }
    sendSys(
      roomId,
      `Simdi calan: ${session.station.name} (${session.station.category}) — durum: ${session.status}`
    );
    return true;
  }

  if (sub === "open") {
    if (session) {
      emitRadioState(session, true);
      sendSys(roomId, "Radyo paneli zaten aktif.");
      return true;
    }
    sendSys(roomId, "Radyo paneli icin /radio list ile istasyonlari goruntule ve /radio play <id> ile baslat.");
    return true;
  }

  sendSys(roomId, `Bilinmeyen radyo komutu: ${sub}. /radio help yaz.`);
  return true;
};
