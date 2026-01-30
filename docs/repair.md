# Repair Mode Policy

*Rules for AI models entering /repair mode*

## Minimal Change Policy
- **Do NOT** rewrite entire files.
- **Do NOT** change architectural patterns during a repair.
- **DO** apply atomic fixes using `edit` (search & replace).

## Diff-Only Requirement
- When proposing a fix, isolate the specific function or logic block causing the error.
- Verify that the fix does not break related tests or components.

## Change Budget
- If a repair requires touching >3 files, stop and request a review or switch to /plan mode.
- Avoid "shotgun debugging" (trying random fixes). Analyze the error log first.
