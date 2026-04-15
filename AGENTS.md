# Repository Instructions

- After completing any code or config change requested by the user, automatically run the necessary verification, then `git add`, `git commit`, `git push`, and deploy to the Contabo production server without waiting for a separate user instruction.
- Treat automatic deploy as the default workflow for this repository unless the user explicitly says not to commit, not to push, or not to deploy.
- Before deploy, avoid including unrelated local changes in the commit; stage and commit only the files relevant to the requested change.
- If push or deploy fails, report the exact blocker and stop there instead of making risky workaround changes.
- Preserve existing audio quality features such as noise suppression, filtering, and limiter behavior unless the user explicitly asks to change them.
- Production deploy target for this repository is the Contabo server, using the existing deployment flow in `/opt/discordofmine/deploy.sh`.
