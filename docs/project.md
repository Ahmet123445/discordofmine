# Project Definition

## Goal
Build a private, low-latency communication platform for a small group of friends (5-10 users). The application must support real-time text messaging, file sharing, voice chat, and screen sharing. The UI should be minimalistic ("eye-friendly") and performance-focused.

## Non-Goals
- Enterprise-scale features (SSO, complex permissions, organizations).
- Public registration (invite or pre-approved only).
- Social media features (feeds, likes, followers).
- Monetization or ad integration.

## Core Principles
1. **Simplicity:** Minimal UI, distraction-free.
2. **Stability:** Reliable voice/video connection is priority #1.
3. **Privacy:** Data owned by the group, no external tracking.
4. **Context Preservation:** Future AI models must respect existing architectural choices.

## Locked Tech Stack
*Modifying this requires an ADR in `decisions.md`*

- **Frontend:** Next.js (React), Tailwind CSS, Lucide React (Icons).
- **Backend:** Node.js (Express or Fastify).
- **Real-time:** Socket.io (Signaling & Chat), SimplePeer/WebRTC (Voice/Screen).
- **Database:** PostgreSQL (via Supabase or Render managed) or lightweight SQLite (if persistence requirements are low).
- **Storage:** Cloud object storage (AWS S3 compatible) for file sharing.
- **Deployment:** 
  - Frontend: Vercel
  - Backend: Render.com

## Folder Structure (LOCKED)
```
/
├── client/          # Next.js Frontend
├── server/          # Node.js Backend
├── shared/          # Shared types/interfaces
├── docs/            # Project documentation (Context Memory)
└── scripts/         # Devops/Utility scripts
```
