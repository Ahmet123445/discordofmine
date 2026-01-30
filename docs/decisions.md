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
