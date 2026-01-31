# Architecture Decision Records (ADR)

*Format: [ID] [Title] [Status]*

## Template
### ADR-000: Example Decision
- **Status:** Proposed / Accepted / Deprecated
- **Context:** Why is this decision needed?
- **Decision:** What are we doing?
- **Consequences:** Positive and negative impacts.

---

## History

### ADR-001: Monolithic Backend
- **Status:** Accepted
- **Context:** The app serves only 5-10 users.
- **Decision:** Use a single Node.js server instance on Render.
- **Consequences:**
  - (+) Simple deployment and state management for sockets.
  - (-) Scaling beyond vertical limits is harder (not an issue for 10 users).

### ADR-002: WebRTC for Media
- **Status:** Accepted
- **Context:** Low latency voice/screen share needed.
- **Decision:** Use P2P WebRTC (mesh network).
- **Consequences:**
  - (+) Free, no media server cost.
  - (-) High bandwidth for client if users > 5-6 in one call (acceptable for this scope).

### ADR-003: SQLite over PostgreSQL
- **Status:** Accepted
- **Context:** Simple data model (users, messages), low user count.
- **Decision:** Use SQLite with better-sqlite3 for persistence.
- **Consequences:**
  - (+) No external database service needed.
  - (+) Zero configuration, single file.
  - (-) File-based, not ideal for horizontal scaling (acceptable).

### ADR-004: Dynamic Import for simple-peer
- **Status:** Accepted
- **Context:** simple-peer uses Node.js globals (Buffer, process) that break SSR.
- **Decision:** Dynamically import simple-peer only on client side with `ssr: false`.
- **Consequences:**
  - (+) Prevents SSR crashes.
  - (+) Works with Next.js App Router.
  - (-) Slight delay on first voice join (acceptable).

### ADR-005: Speaking Indicator Removal
- **Status:** Accepted (2026-01-31)
- **Context:** Web Audio API speaking detection was causing audio crackling.
- **Decision:** Remove all speaking detection code using AudioContext/AnalyserNode.
- **Consequences:**
  - (+) Clean audio quality restored.
  - (-) No visual indicator when users speak.
  - **Future:** Consider server-side approach or optimized client detection.

### ADR-006: Screen Share Hide vs Stop
- **Status:** Accepted (2026-01-31)
- **Context:** Users wanted to close screen share window but re-watch later without streamer restarting.
- **Decision:** Close button hides stream (adds to hiddenStreams set) instead of stopping tracks.
- **Consequences:**
  - (+) Can re-watch by clicking screen icon on user.
  - (-) Stream continues consuming bandwidth even when hidden.
  - **Mitigation:** User count is small (5-10), bandwidth impact acceptable.

### ADR-007: All Rooms Users Broadcast
- **Status:** Accepted (2026-01-31)
- **Context:** Users want to see who is in other voice rooms without joining.
- **Decision:** Server broadcasts `all-rooms-users` event on every join/leave.
- **Consequences:**
  - (+) Full visibility of voice room occupancy.
  - (-) Slightly more socket traffic.
  - **Note:** Users in other rooms shown with gray avatars (no real-time features).
