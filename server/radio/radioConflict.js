// Pure predicates for music <-> radio conflict rules. No side effects.
// Consumed by both the radio command/socket handlers AND server/index.js via
// the exported `isRadioActive` / `radioConflictReason` helpers.

import { getAdapter, isRadioEnabled } from "./adapter.js";
import { radioSessions } from "./radioSession.js";

export const isRadioActiveInRoom = (voiceRoomId) => {
  if (!isRadioEnabled()) return false;
  if (!voiceRoomId) return false;
  return radioSessions.has(voiceRoomId);
};

export const isMusicActiveInRoom = (voiceRoomId) => {
  if (!voiceRoomId) return false;
  const { musicSessions } = getAdapter();
  if (!musicSessions) return false;
  const session = musicSessions.get(voiceRoomId);
  if (!session) return false;
  // Any queued / playing / current track counts as active.
  return !!(session.isPlaying || session.current || (session.queue && session.queue.length > 0));
};

export const canStartRadio = (voiceRoomId) => {
  if (isMusicActiveInRoom(voiceRoomId)) {
    return {
      ok: false,
      reason: "music_active",
      message:
        "Bu odada su anda muzik oynatiliyor. Radyo baslatmak icin once muzigi durdurun (/stop)."
    };
  }
  if (isRadioActiveInRoom(voiceRoomId)) {
    return {
      ok: false,
      reason: "radio_already_active",
      message: "Bu odada zaten aktif bir radyo yayini var."
    };
  }
  return { ok: true };
};

export const canStartMusic = (voiceRoomId) => {
  if (isRadioActiveInRoom(voiceRoomId)) {
    return {
      ok: false,
      reason: "radio_active",
      message:
        "Bu odada su anda radyo yayini aktif. Muzik baslatmak icin once radyoyu durdurun (/radio stop)."
    };
  }
  return { ok: true };
};
