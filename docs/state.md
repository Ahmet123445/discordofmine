# Project State

*AI Models: Update this file at the end of every session.*

## Current Status
- **Phase:** Production (Live)
- **Last Updated:** 2026-04-16
- **App Name:** V A T A N A S K I (renamed from DiscordOfMine)

## Deployment URLs
- **Server:** root@167.86.99.131
- **Frontend:** http://167.86.99.131:3002
- **Backend:** http://167.86.99.131:3001
- **Repository:** https://github.com/Ahmet123445/discordofmine

## Completed Features

### Phase 1: Foundation
- [x] Project Documentation Setup
- [x] Initialize Git Repo
- [x] Basic Next.js Setup (Client)
- [x] Basic Express + Socket.io Setup (Server)
- [x] Setup Folder Structure
- [x] Connect Remote Repository

### Phase 2: Core Features
- [x] User Authentication (JWT + bcrypt)
- [x] Real-time Text Chat (Socket.io + SQLite)
- [x] Voice Chat (WebRTC mesh network)
- [x] Screen Sharing (with audio support)
- [x] Voice Controls (Mute, Deafen)
- [x] File/Image Uploads (multer)
- [x] Sound Effects (join/leave)

### Phase 3: Enhanced Features
- [x] Ctrl+V Screenshot Paste (with preview dialog)
- [x] Message Deletion (own messages only)
- [x] Custom Keybinds (mute/deafen, saved to localStorage)
- [x] Voice Room Creation (add custom channels)
- [x] Per-user Volume Sliders (0-200% playback boost)
- [x] Screen Share Re-watch (hide instead of stop)
- [x] All Rooms User Display (see users in other voice rooms)
- [x] Screen Share with Audio

### Phase 4: Deployment
- [x] Environment Variables configured
- [x] Self-hosted VPS deployment (Frontend + Backend)
- [x] CORS configured for production

## Known Issues / Limitations

### Active Issues
- **Speaking Indicator REMOVED:** Was causing audio crackling due to Web Audio API overhead. Need alternative approach (server-side or optimized).

### Architectural Limitations
- **Local Storage Risk:** Uploads are on local disk; regular backup is required.
- **WebRTC NAT:** TURN support is now configurable via env vars; quality still depends on TURN reachability and region latency.
- **Mesh Network Limit:** Voice quality may degrade with 6+ users in same room.

## Recent Changes (Last Session)

### Commit: 543ca74
- Removed speaking detection (was causing audio crackling)
- Fixed chat messages not appearing
- Simplified AudioPlayer component

### Working Tree (2026-04-16)
- Chat composer now routes Enter, paste-preview send, file upload, and drag-drop image send through a unified send flow
- Slash commands like `/skip` now resolve from the active suggestion on Enter, while argument-based commands autocomplete safely
- Unknown slash commands now return a visible system hint instead of failing silently
- Remote user playback volume now uses a real gain stage up to 200% without changing the microphone noise suppression / limiter chain

### Commit: 1b8f92c
- Enter key message sending
- Screen share re-watch functionality
- Screen share audio support
- All rooms users display
- (Speaking indicator - later removed)

### Commit: c2b91fc
- Ctrl+V screenshot paste
- Message deletion
- Custom keybinds with localStorage

### Commit: 758824d
- Screen share memory cleanup
- User list with status icons
- Renamed to V A T A N A S K I
- Volume percentage display

## Environment Variables

### Frontend (VPS)
```
NEXT_PUBLIC_API_URL=http://167.86.99.131:3001
```

### Backend (VPS)
```
JWT_SECRET=your-secure-random-string
PORT=3001
```

## File Structure
```
discordofmine/
├── client/                    # Next.js Frontend
│   ├── app/
│   │   ├── page.tsx          # Landing page
│   │   ├── login/page.tsx    # Login/Register
│   │   ├── chat/page.tsx     # Main chat (456 lines)
│   │   └── layout.tsx        # Root layout + polyfills
│   ├── components/
│   │   ├── VoiceChat.tsx     # Voice/Screen share (~800 lines)
│   │   └── GlobalPolyfill.tsx
│   └── public/sounds/        # join.mp3, leave.mp3
├── server/                    # Express Backend
│   ├── index.js              # Main server (~205 lines)
│   ├── db.js                 # SQLite setup
│   ├── routes/
│   │   ├── auth.js           # Authentication
│   │   └── upload.js         # File uploads
│   └── data/app.db           # SQLite database
└── docs/                      # AI Context Documentation
```

## Next Steps (Suggested)
1. Test voice chat thoroughly in production
2. Consider adding TURN server for better connectivity
3. Persist voice rooms to database
4. Add user presence (online/offline status)
5. Mobile responsive improvements
6. Consider alternative speaking indicator (server-side)
