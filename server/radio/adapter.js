// Dependency injection container. The host (server/index.js) passes in
// references to its shared runtime primitives via initRadio({...}). The radio
// module never touches host globals directly — making it trivial to remove or
// feature-flag without touching music code.

const refs = {
  io: null,
  app: null,
  usersInVoice: null,
  ICE_SERVERS: null,
  sendSystemMessage: null,
  broadcastAllVoiceUsers: null,
  musicSessions: null,
  enabled: false,
  initialized: false
};

export const setAdapterRefs = (next) => {
  Object.assign(refs, next, { initialized: true });
};

export const getAdapter = () => refs;
export const isRadioEnabled = () => refs.enabled === true && refs.initialized === true;
