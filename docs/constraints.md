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

## Render/Vercel Constraints
- **Render Free Tier:** Server spins down after inactivity. Keep-alive mechanism may be needed.
- **Vercel Functions:** 10s execution limit (avoid long polling or heavy computation in serverless functions).
