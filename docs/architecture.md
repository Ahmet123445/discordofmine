# System Architecture

## System Layers
1. **Presentation Layer (Client):** Next.js application handling UI, local state, and media streams.
2. **Communication Layer (Socket/WebRTC):** Handles real-time events (chat) and peer-to-peer connections (voice/screen).
3. **Service Layer (API):** RESTful endpoints for authentication, history fetching, and file uploads.
4. **Persistence Layer:** Database for user accounts and chat logs.

## AI Workflow
Future AI models must adhere to this flow:
1.  **/plan:** Read `docs/state.md` and `docs/project.md`. Propose changes.
2.  **/build:** Implement changes in `client/` or `server/`. Update `docs/state.md`.
3.  **/repair:** specific fixes only. Do not refactor unless critical.

## Core Patterns
- **Adapter Pattern:** Use adapters for external services (Storage, DB) to allow easy switching if Render/Vercel constraints change.
- **Repository Pattern:** Database access must be abstracted.

## Forbidden Patterns
- **God Classes:** Do not put all socket logic in one file. Split by namespaces/features (e.g., `chatHandler`, `voiceHandler`).
- **Direct DB Access in UI:** Client must never query DB directly; use API/Socket.
- **Over-Engineering:** No microservices. Monolithic backend is required for this scale (10 users).
