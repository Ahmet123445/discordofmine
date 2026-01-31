# Project Memory

## How to Preserve Context
1. **File Structure:** The project structure is the source of truth.
2. **Documentation:** `docs/` folder contains the "brain" of the project.
3. **Comments:** Critical business logic must be commented with context.

## Snapshot Format
When handing off to a new AI session/model, ensure:
1. `docs/state.md` is current.
2. Any half-finished code is marked with `// TODO: [AI_SESSION_ID] finish this`.
3. No syntax errors exist in the codebase (unless debugging).

## Immutable Facts
- The user is building a private tool for friends (5-10 users).
- Security tokens (API keys) are in `.env`, NEVER in code or docs.
- We prefer "boring" technology (proven, stable) over "hype" technology.
- User speaks Turkish, prefers responses in Turkish.
- App name changed to "V A T A N A S K I" (was DiscordOfMine).

## Critical Files to Read First
When starting a new session, read these files to understand current state:

1. **`docs/state.md`** - Current project status and recent changes
2. **`docs/decisions.md`** - ADRs explaining why things are the way they are
3. **`client/components/VoiceChat.tsx`** - Main voice/video logic (~800 lines)
4. **`server/index.js`** - Socket.io event handlers (~205 lines)
5. **`client/app/chat/page.tsx`** - Main chat UI (~456 lines)

## Lessons Learned

### Web Audio API Causes Audio Crackling
- **Date:** 2026-01-31
- **Issue:** Speaking indicator using `AudioContext` + `AnalyserNode` with `requestAnimationFrame` caused severe audio distortion.
- **Resolution:** Completely removed speaking detection. Audio quality restored.
- **Future Approach:** If speaking indicator needed, consider:
  - Server-side detection (analyze audio packets)
  - Much lower frequency polling (once per second instead of every frame)
  - Web Worker to offload processing

### SSR Crashes with WebRTC Libraries
- **Date:** 2026-01-30
- **Issue:** `simple-peer` and related WebRTC libraries require browser globals (`Buffer`, `process`).
- **Resolution:** 
  - Dynamic import with `ssr: false`
  - Global polyfills in `layout.tsx` using `<script>` tags
  - `GlobalPolyfill.tsx` component

### Screen Share Stream Lifecycle
- **Date:** 2026-01-31
- **Issue:** Stopping stream tracks prevents re-watching.
- **Resolution:** Hide streams in UI state instead of calling `track.stop()`. User can unhide by clicking screen icon.

## Socket Events Reference

### Chat Events
- `join-room` - Join a text channel
- `send-message` - Send a message
- `message-received` - Receive a message
- `message-deleted` - Message was deleted

### Voice Events
- `join-voice` - Join voice room with user data
- `all-voice-users` - List of users in joined room
- `user-joined-voice` - New user joined with signal
- `sending-signal` - Send WebRTC signal
- `returning-signal` - Return WebRTC signal
- `receiving-returned-signal` - Receive returned signal
- `user-left-voice` - User left voice
- `leave-voice` - Leave voice room
- `all-rooms-users` - All users in all voice rooms

## Environment Setup (Local Development)
```bash
# Terminal 1 - Backend
cd server && npm run dev

# Terminal 2 - Frontend
cd client && npm run dev
```

## Deployment Checklist
1. Ensure all changes committed and pushed
2. Vercel auto-deploys from main branch
3. Render auto-deploys from main branch
4. Check Vercel logs for build errors
5. Check Render logs for runtime errors
6. Test voice connection between two users
