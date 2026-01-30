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
- The user is building a private tool for friends.
- Security tokens (API keys) are in `.env`, NEVER in code or docs.
- We prefer "boring" technology (proven, stable) over "hype" technology.
