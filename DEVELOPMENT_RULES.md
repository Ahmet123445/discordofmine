# Kombogame Development Rules

Bu belge, projenin stabil kalması için uyulması gereken kritik kuralları içerir.

---

## 1. WebRTC Audio (Müzik Botu)

### RTCAudioSource.onData() Kuralları

`RTCAudioSource.onData()` fonksiyonu **tam olarak 1920 byte** bekler. Bu değer sabittir:

```
48000 Hz × 2 kanal × 2 byte × 0.01 saniye = 1920 byte
```

**ASLA** farklı boyutta veri göndermeyin. FFmpeg'den gelen veriler farklı boyutlarda gelebilir, bu yüzden:

1. Veriyi bir buffer'da toplayın
2. Buffer 1920 byte veya daha fazla olduğunda, tam 1920 byte'lık çerçeveler çıkarın
3. **ÖNEMLİ:** `Buffer.slice()` bir "view" döndürür, yeni bir kopya değil. `Int16Array` oluşturmadan önce yeni bir `ArrayBuffer`'a kopyalamanız gerekir:

```javascript
// YANLIŞ - frame.buffer orijinal büyük buffer'ı işaret eder
const samples = new Int16Array(frame.buffer, frame.byteOffset, frame.length / 2);

// DOĞRU - Yeni ArrayBuffer'a kopyala
const arrayBuffer = new ArrayBuffer(FRAME_SIZE);
const view = new Uint8Array(arrayBuffer);
for (let i = 0; i < FRAME_SIZE; i++) {
    view[i] = frameData[i];
}
const samples = new Int16Array(arrayBuffer);
```

### WebRTC Peer Ayarları

İstemci ve sunucu tarafında peer ayarları **uyumlu olmalıdır**:

```javascript
// Her iki tarafta da aynı olmalı:
{
    trickle: false,  // İstemcide false ise sunucuda da false olmalı
    config: {
        iceServers: [
            { urls: 'stun:stun.l.google.com:19302' },
            { urls: 'stun:global.stun.twilio.com:3478' }
        ]
    }
}
```

---

## 2. Oda Yönetimi (Room Management)

### Room ID Formatları

- **Sunucu/Server ID:** `roomname-1234` (veritabanında saklanan)
- **Ses Kanalı/Voice Room ID:** `roomname-1234-general` veya `roomname-1234-gaming`

### getRoomStats() Kuralları

Voice room ID'sinden server ID'yi çıkarırken:

```javascript
// DOĞRU - lastIndexOf kullan
const lastDashIndex = voiceRoomId.lastIndexOf('-');
const serverId = voiceRoomId.substring(0, lastDashIndex);

// YANLIŞ - split ve pop kullanma (birden fazla tire varsa sorun çıkar)
const parts = voiceRoomId.split('-');
parts.pop();
const serverId = parts.join('-');
```

### Cleanup Kuralları

- Odaları silmeden önce **en az 1 saat** bekleyin
- Cleanup interval'i **5 dakika** olmalı, 30 saniye değil
- Boş `usersInVoice` ve `usersInRoom` girdilerini her zaman temizleyin

---

## 3. Socket.io Event'leri

### Broadcast Kuralları

Bir kullanıcı veya bot odaya katıldığında/ayrıldığında:

1. `usersInVoice` veya `usersInRoom` nesnesini güncelleyin
2. `broadcastAllVoiceUsers()` çağırın
3. İlgili odaya özel event gönderin: `io.to(roomId).emit(...)`
4. Gerekirse global event gönderin: `io.emit("all-rooms-users", usersInVoice)`

### Bot Ayrılma Sırası

```javascript
// 1. Müziği durdur
musicBot.stopMusic();
musicBot.leave();

// 2. Tüm odalardan botu kaldır
for (const rId in usersInVoice) {
    usersInVoice[rId] = usersInVoice[rId].filter(u => u.id !== "music-bot");
    io.to(rId).emit('user-left-voice', "music-bot");
    if (usersInVoice[rId].length === 0) {
        delete usersInVoice[rId];
    }
}

// 3. Herkese yayınla
broadcastAllVoiceUsers();
io.emit("all-rooms-users", usersInVoice);
```

---

## 4. SoundCloud/YouTube Entegrasyonu

### play-dl Kuralları

1. SoundCloud kullanmadan önce `getFreeClientID()` ile client ID alın ve `setToken()` ile ayarlayın
2. YouTube IP engellemesi var, doğrudan stream almak yerine YouTube'da arayıp SoundCloud'da stream alın
3. Arama stratejisi: SoundCloud > YouTube arama + SoundCloud stream > Direkt YouTube (fallback)

---

## 5. Performans Kuralları

### RAM Kullanımı

- Speaking detection (konuşma algılama) eklemeyin - yüksek CPU/RAM kullanır
- Gereksiz broadcast'lerden kaçının
- Cleanup interval'lerini çok sık yapmayın

### Sunucu Çökmelerini Önleme

- Tüm async fonksiyonlarda try-catch kullanın
- FFmpeg process'lerini `SIGKILL` ile sonlandırın
- Peer error'larını yakalayın ve peer'ı silin

---

## Versiyon Geçmişi

| Tarih | Değişiklik |
|-------|------------|
| 2026-02-01 | İlk oluşturma: Audio buffer, room tracking, bot kuralları |
