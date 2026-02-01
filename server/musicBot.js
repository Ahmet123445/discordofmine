import pkg from '@roamhq/wrtc';
const { nonstandard } = pkg;
import Peer from 'simple-peer';
import play from 'play-dl';
import ffmpeg from 'ffmpeg-static';
import { spawn } from 'child_process';

const { RTCAudioSource } = nonstandard;

class MusicBot {
    constructor(io, broadcastRoomUpdate) {
        this.io = io;
        this.broadcastRoomUpdate = broadcastRoomUpdate;
        this.peers = {}; // { socketId: SimplePeer }
        this.currentRoom = null;
        this.audioSource = null;
        this.ffmpegProcess = null;
        this.isPlaying = false;
        this.botId = "music-bot";
        this.botName = "Music Bot";
        
        // Queue system
        this.queue = [];
        this.currentTrack = null;
        this.textRoomId = null;
    }

    // Join a voice room
    join(roomId) {
        if (this.currentRoom === roomId) return;
        if (this.currentRoom) this.leave();

        console.log(`[MusicBot] Joining room ${roomId}`);
        this.currentRoom = roomId;
    }

    leave() {
        if (!this.currentRoom) return;
        
        console.log(`[MusicBot] Leaving room ${this.currentRoom}`);
        this.stopMusic();
        this.queue = [];
        this.currentTrack = null;
        
        Object.values(this.peers).forEach(peer => peer.destroy());
        this.peers = {};
        this.currentRoom = null;
    }

    // Send a message to the text channel
    sendMessage(content) {
        if (this.textRoomId) {
            this.io.to(this.textRoomId).emit("message-received", {
                id: Date.now(),
                content: content,
                user_id: 0,
                username: "Music Bot",
                type: "text",
                room_id: this.textRoomId,
                created_at: new Date().toISOString()
            });
        }
    }

    // Add to queue - ONLY uses SoundCloud (no YouTube API calls)
    async addToQueue(query, textRoomId, voiceRoomId) {
        this.textRoomId = textRoomId;
        this.join(voiceRoomId);
        
        try {
            // Extract search query from YouTube URL if needed
            let searchQuery = query;
            
            if (query.includes("youtube.com") || query.includes("youtu.be")) {
                // Just extract and clean for search - don't call YouTube API
                searchQuery = query
                    .replace(/https?:\/\/(www\.)?(youtube\.com|youtu\.be|music\.youtube\.com)\/(watch\?v=|shorts\/)?/gi, '')
                    .replace(/[&?].*$/g, '')
                    .replace(/[-_]/g, ' ')
                    .trim();
                    
                if (searchQuery.length < 3) {
                    searchQuery = query; // Use original if cleanup failed
                }
            }

            this.sendMessage(`Araniyor: ${searchQuery}`);
            
            // Search ONLY on SoundCloud (no IP blocking)
            const results = await play.search(searchQuery, { 
                source: { soundcloud: "tracks" }, 
                limit: 1 
            });
            
            if (results.length === 0) {
                this.sendMessage(`Bulunamadi: ${searchQuery}`);
                return false;
            }

            const track = {
                title: results[0].name || results[0].title || searchQuery,
                url: results[0].url,
                duration: results[0].durationInSec || 0
            };

            this.queue.push(track);
            
            if (this.queue.length === 1 && !this.isPlaying) {
                this.sendMessage(`Kanal: ${track.title}`);
                await this.playNext();
                return true;
            } else {
                this.sendMessage(`Siraya eklendi (#${this.queue.length}): ${track.title}`);
                return true;
            }
        } catch (err) {
            console.error("[MusicBot] Add to queue error:", err.message);
            this.sendMessage(`Hata: Sarki bulunamadi veya kaynaga ulasilamadi.`);
            return false;
        }
    }

    // Play next track in queue
    async playNext() {
        if (this.queue.length === 0) {
            this.sendMessage("Sira bitti.");
            this.isPlaying = false;
            return;
        }

        this.currentTrack = this.queue[0];
        
        try {
            console.log(`[MusicBot] Playing: ${this.currentTrack.title} from ${this.currentTrack.url}`);
            
            // Get stream from SoundCloud
            const streamInfo = await play.stream(this.currentTrack.url, {
                discordPlayerCompatibility: true
            });

            console.log(`[MusicBot] Stream type: ${streamInfo.type}`);

            // Initialize WebRTC Audio Source
            this.audioSource = new RTCAudioSource();
            const track = this.audioSource.createTrack();
            const mediaStream = new pkg.MediaStream([track]);
            this.currentStream = mediaStream;

            // Start FFMPEG
            this.startFFmpeg(streamInfo.stream);

            this.isPlaying = true;

            // Add stream to existing peers
            Object.values(this.peers).forEach(peer => {
                try {
                    peer.addStream(this.currentStream);
                } catch (e) {
                    console.error("Error adding stream to peer:", e.message);
                }
            });

        } catch (err) {
            console.error("[MusicBot] Play error:", err.message);
            this.sendMessage(`Calinamadi: ${this.currentTrack.title}`);
            this.queue.shift();
            if (this.queue.length > 0) {
                await this.playNext();
            }
        }
    }

    // Skip current track
    skip() {
        if (this.queue.length === 0) {
            this.sendMessage("Sirada sarki yok.");
            return;
        }
        
        const skipped = this.queue.shift();
        this.sendMessage(`Atlandi: ${skipped.title}`);
        this.stopMusic();
        this.playNext();
    }

    // Show queue
    getQueueList() {
        if (this.queue.length === 0) {
            return "Sira bos.";
        }
        
        let list = "Siradaki sarkilar:\n";
        this.queue.forEach((track, index) => {
            const prefix = index === 0 ? "(Simdi)" : `#${index + 1}`;
            list += `${prefix} ${track.title}\n`;
        });
        return list;
    }

    // Stop music
    stopMusic() {
        if (this.ffmpegProcess) {
            this.ffmpegProcess.kill('SIGKILL');
            this.ffmpegProcess = null;
        }
        this.audioSource = null;
        this.isPlaying = false;
        
        if (this.currentStream) {
            Object.values(this.peers).forEach(peer => {
                try {
                    peer.removeStream(this.currentStream);
                } catch (e) {}
            });
            this.currentStream = null;
        }
    }

    startFFmpeg(inputStream) {
        const args = [
            '-re',
            '-i', '-',
            '-f', 's16le',
            '-ar', '48000',
            '-ac', '2',
            '-'
        ];

        this.ffmpegProcess = spawn(ffmpeg, args);

        inputStream.pipe(this.ffmpegProcess.stdin);

        let packetCount = 0;
        this.ffmpegProcess.stdout.on('data', (chunk) => {
            if (this.audioSource) {
                if (packetCount < 3) {
                    console.log(`[FFmpeg] Chunk: ${chunk.length} bytes`);
                }
                packetCount++;
                
                const samples = new Int16Array(chunk.buffer, chunk.byteOffset, chunk.length / 2);
                this.audioSource.onData({
                    samples,
                    sampleRate: 48000,
                    bitsPerSample: 16,
                    channelCount: 2
                });
            }
        });

        this.ffmpegProcess.stderr.on('data', (data) => {
            // Debug: console.log(`[FFmpeg] ${data}`);
        });

        this.ffmpegProcess.on('close', (code) => {
            console.log(`[FFmpeg] Exited: ${code}`);
            if (this.isPlaying && this.queue.length > 0) {
                this.queue.shift();
                this.playNext();
            }
        });
    }

    // Initiate connection to a user
    initiateConnection(userSocketId) {
        if (!this.currentRoom || this.peers[userSocketId]) return;

        console.log(`[MusicBot] Connecting to ${userSocketId}`);

        const peer = new Peer({
            initiator: true,
            wrtc: pkg,
            stream: this.currentStream || null,
            config: {
                iceServers: [
                    { urls: 'stun:stun.l.google.com:19302' },
                    { urls: 'stun:global.stun.twilio.com:3478' }
                ]
            }
        });

        this.peers[userSocketId] = peer;

        peer.on('signal', (signal) => {
            this.io.to(userSocketId).emit('user-joined-voice', {
                signal: signal,
                callerID: this.botId,
                username: this.botName
            });
        });

        peer.on('connect', () => {
            console.log(`[MusicBot] Connected to ${userSocketId}`);
        });

        peer.on('close', () => {
            console.log(`[MusicBot] Disconnected from ${userSocketId}`);
            delete this.peers[userSocketId];
        });

        peer.on('error', (err) => {
            console.error(`[MusicBot] Peer error ${userSocketId}:`, err.message);
        });
    }

    // Handle incoming signal
    handleSignal(userSocketId, signal) {
        if (!this.currentRoom) return;

        if (this.peers[userSocketId]) {
            this.peers[userSocketId].signal(signal);
        } else {
            const peer = new Peer({
                initiator: false,
                wrtc: pkg,
                stream: this.currentStream || null,
                config: {
                    iceServers: [
                        { urls: 'stun:stun.l.google.com:19302' },
                        { urls: 'stun:global.stun.twilio.com:3478' }
                    ]
                }
            });

            this.peers[userSocketId] = peer;

            peer.on('signal', (outSignal) => {
                this.io.to(userSocketId).emit('receiving-returned-signal', {
                    signal: outSignal,
                    id: this.botId
                });
            });

            peer.on('connect', () => {
                console.log(`[MusicBot] Connected to ${userSocketId}`);
            });

            peer.on('close', () => {
                delete this.peers[userSocketId];
            });

            peer.on('error', (err) => {
                console.error(`[MusicBot] Peer error:`, err.message);
            });

            peer.signal(signal);
        }
    }

    removePeer(socketId) {
        if (this.peers[socketId]) {
            this.peers[socketId].destroy();
            delete this.peers[socketId];
        }
    }
}

export default MusicBot;
