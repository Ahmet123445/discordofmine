# Project State

*AI Models: Update this file at the end of every session.*

## Current Status
- **Phase:** Production (Live)
- **Last Updated:** 2026-01-31
- **App Name:** V A T A N A S K I (renamed from DiscordOfMine)

## Deployment URLs
- **Frontend:** https://discordofmine-56ee.vercel.app
- **Backend:** Render.com (Node.js service)
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
- [x] Per-user Volume Sliders (0-100%)
- [x] Screen Share Re-watch (hide instead of stop)
- [x] All Rooms User Display (see users in other voice rooms)
- [x] Screen Share with Audio

### Phase 4: Deployment
- [x] Environment Variables configured
- [x] Vercel deployment (Frontend)
- [x] Render.com deployment (Backend)
- [x] CORS configured for production

## Known Issues / Limitations

### Active Issues
- **Speaking Indicator REMOVED:** Was causing audio crackling due to Web Audio API overhead. Need alternative approach (server-side or optimized).

### Architectural Limitations
- **Ephemeral Storage:** Uploads on Render Free Tier are temporary (lost on restart).
- **WebRTC NAT:** Some restrictive networks may block P2P. TURN server would help but not implemented.
- **Mesh Network Limit:** Voice quality may degrade with 6+ users in same room.

## Recent Changes (Last Session)

### Commit: 543ca74
- Removed speaking detection (was causing audio crackling)
- Fixed chat messages not appearing
- Simplified AudioPlayer component

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

### Vercel (Frontend)
```
NEXT_PUBLIC_API_URL=https://your-render-backend-url.onrender.com
```

### Render (Backend)
```
JWT_SECRET=your-secure-random-string
PORT=10000
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
