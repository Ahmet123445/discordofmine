# Prompt & Interaction Policy

## /plan Mode
- **Goal:** Architectural changes or new features.
- **Output:** Must update `state.md` and relevant docs *before* code.
- **Requirement:** Check `constraints.md` before proposing solutions.

## /build Mode
- **Goal:** Implementation.
- **Output:** Clean, commented code following existing style.
- **Rule:** Never remove comments labeled `// LOCKED` or `// DO NOT EDIT`.

## /repair Mode
- **Goal:** Bug fixing.
- **Rule:** Consult `repair.md`. Focus on stability.

## Output Discipline
- Do not explain standard code (e.g., "I imported React").
- Explain **why** a complex decision was made.
- Always provide the full filepath when creating/editing files.
