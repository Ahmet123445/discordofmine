# API & Socket Contract

*Rule: This contract is binding. Changes require updating this file first.*

## HTTP Endpoints (Placeholder)

### Auth
- `POST /api/auth/register` - { username, password } -> { token, user }
- `POST /api/auth/login` - { username, password } -> { token, user }

### Uploads
- `POST /api/upload` - Multipart/Form-Data -> { fileUrl }

## Socket Events

### Client -> Server
- `join-room`: { roomId }
- `send-message`: { content, type: 'text'|'file' }
- `voice-signal`: { signalData, targetPeerId } (WebRTC Handshake)
- `screen-share-start`: { roomId }

### Server -> Client
- `message-received`: { id, sender, content, timestamp }
- `user-joined`: { userId, username }
- `voice-signal-relay`: { signalData, fromPeerId }

## Error Format
All API responses must follow:
```json
{
  "success": false,
  "error": "ERROR_CODE",
  "message": "Human readable message"
}
```
