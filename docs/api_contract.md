# API Contract

## REST Endpoints

### Authentication

#### POST /api/auth/register
```json
Request:
{
  "username": "string",
  "password": "string"
}

Response (201):
{
  "success": true,
  "token": "jwt-token",
  "user": { "id": 1, "username": "string" }
}
```

#### POST /api/auth/login
```json
Request:
{
  "username": "string",
  "password": "string"
}

Response (200):
{
  "success": true,
  "token": "jwt-token",
  "user": { "id": 1, "username": "string" }
}
```

### Messages

#### GET /api/messages
```json
Response (200):
[
  {
    "id": 1,
    "content": "string",
    "user_id": 1,
    "username": "string",
    "type": "text|file",
    "created_at": "ISO-8601"
  }
]
```

#### DELETE /api/messages/:id
```json
Request:
{
  "userId": 1
}

Response (200):
{
  "success": true
}

Response (403):
{
  "error": "Not authorized to delete this message"
}
```

### File Upload

#### POST /api/upload
```
Content-Type: multipart/form-data
Body: file (binary)

Response (200):
{
  "success": true,
  "url": "/uploads/filename.ext",
  "filename": "filename.ext"
}
```

## Socket.io Events

### Client → Server

| Event | Payload | Description |
|-------|---------|-------------|
| `join-room` | `roomId: string` | Join text channel |
| `send-message` | `{ content, user, type, fileUrl?, fileName? }` | Send message |
| `join-voice` | `{ roomId, user }` | Join voice room |
| `sending-signal` | `{ userToSignal, callerID, signal, username }` | WebRTC signaling |
| `returning-signal` | `{ signal, callerID }` | WebRTC response |
| `leave-voice` | none | Leave voice room |

### Server → Client

| Event | Payload | Description |
|-------|---------|-------------|
| `message-received` | `Message object` | New message |
| `message-deleted` | `{ id: number }` | Message deleted |
| `all-voice-users` | `[{ id, username }]` | Users in your room |
| `user-joined-voice` | `{ signal, callerID, username }` | New user with signal |
| `receiving-returned-signal` | `{ signal, id }` | Signal response |
| `user-left-voice` | `socketId: string` | User left |
| `all-rooms-users` | `{ [roomId]: [{ id, username }] }` | All voice room users |

## Data Types

### Message
```typescript
interface Message {
  id: number;
  content: string;
  username: string;
  user_id: number;
  created_at: string;
  type: "text" | "file";
  fileUrl?: string;
  fileName?: string;
}
```

### User
```typescript
interface User {
  id: number;
  username: string;
}
```

### VoiceRoom
```typescript
interface VoiceRoom {
  id: string;
  name: string;
}
```

### Keybind
```typescript
interface Keybind {
  key: string;
  alt: boolean;
  ctrl: boolean;
  shift: boolean;
}
```
