// Public entry point for the radio module. The host (server/index.js) calls
// initRadio({...}) once during startup, passing DI references. Everything else
// is exposed via the named exports below.

import { setAdapterRefs, isRadioEnabled } from "./adapter.js";
import { attachRadioSockets } from "./socketHandlers.js";
import { handleRadioCommand } from "./commands.js";
import { radioRestMount } from "./rest.js";
import { isRadioActiveInRoom, canStartMusic } from "./radioConflict.js";
import {
  radioSessions,
  disposeRadioSession,
  isRadioBotId
} from "./radioSession.js";
import { stopStation, radioPlayerExports } from "./radioPlayer.js";
import { logInfo } from "./logger.js";

export const initRadio = ({
  io,
  app,
  usersInVoice,
  ICE_SERVERS,
  sendSystemMessage,
  broadcastAllVoiceUsers,
  musicSessions,
  enabled
} = {}) => {
  setAdapterRefs({
    io,
    app,
    usersInVoice,
    ICE_SERVERS,
    sendSystemMessage,
    broadcastAllVoiceUsers,
    musicSessions,
    enabled: !!enabled
  });

  if (!enabled) {
    logInfo("radio_disabled", {});
    return { enabled: false };
  }

  attachRadioSockets();
  if (app) radioRestMount(app);

  // Graceful shutdown: terminate all sessions + ffmpeg children.
  const shutdown = () => {
    for (const voiceRoomId of Array.from(radioSessions.keys())) {
      const session = radioSessions.get(voiceRoomId);
      try {
        stopStation(session);
      } catch {
        /* noop */
      }
      disposeRadioSession(voiceRoomId);
    }
    logInfo("radio_shutdown_complete", {});
  };
  process.once("SIGTERM", shutdown);
  process.once("SIGINT", shutdown);

  logInfo("radio_enabled", {
    stations: radioSessions.size,
    ffmpegBin: radioPlayerExports.ffmpegBin
  });
  return { enabled: true };
};

// Named public exports used by server/index.js for the minimum-invasive patch.
export {
  handleRadioCommand,
  radioRestMount,
  isRadioActiveInRoom,
  canStartMusic,
  isRadioBotId,
  isRadioEnabled
};
