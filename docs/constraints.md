# Constraints & Limits

## Technical Limits
1. **User Count:** Optimized for < 20 concurrent users.
2. **File Size:** Max upload size 10MB (unless external storage is configured).
3. **Browser Support:** Latest Chrome/Firefox/Edge (WebRTC requirement).

## Performance Targets
- **App Load Time:** < 1.5s
- **Message Latency:** < 100ms
- **Voice Latency:** < 200ms

## Forbidden Frameworks
- **Redux:** Use React Context or Zustand for simplicity.
- **Bootstrap/Material UI:** Use Tailwind CSS for custom, lightweight design.
- **NestJS:** Too heavy for this scope; use standard Express/Fastify.

## Self-Hosted Constraints
- **Single VPS:** Capacity depends on current server resources and PM2 process health.
- **Ops Responsibility:** Backups, monitoring, and security updates must be maintained on the server.
