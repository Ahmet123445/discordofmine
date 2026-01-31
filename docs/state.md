# Project State

*AI Models: Update this file at the end of every session.*

## Current Status
- **Phase:** Deployment Prep
- **Last Updated:** 2026-01-31

## Roadmap / Tasks

### Phase 1: Foundation (Completed)
- [x] Project Documentation Setup
- [x] Initialize Git Repo
- [x] Basic Next.js Setup (Client)
- [x] Basic Express + Socket.io Setup (Server)
- [x] Setup Folder Structure (`client`, `server`, `shared`)
- [x] Connect Remote Repository (`Ahmet123445/discordofmine`)

### Phase 2: Core Features (Completed)
- [x] User Authentication
- [x] Real-time Text Chat
- [x] Voice Chat (WebRTC)
- [x] Screen Sharing
- [x] Voice Controls & Sound Effects
- [x] File/Image Uploads (Local storage for MVP)

### Phase 3: Deployment (Pending)
- [ ] Configure Environment Variables
- [ ] Setup `render.yaml` or Build Scripts
- [ ] Update API URLs to production addresses

## Known Issues / Blockers
- **File Persistence:** Files are stored in `server/uploads`. On Render Free Tier, these will disappear if the server restarts. (User advised "Render backend, Vercel frontend", so this is a known limitation unless we add S3).
- **API URL:** Still `localhost:3001` in client code.

## Context Snapshot
- **Uploads:** Users can click the "Upload" icon next to the input box. Images render as previews, other files as download links.
