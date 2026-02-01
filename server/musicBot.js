import pkg from '@roamhq/wrtc';
const { nonstandard } = pkg;
import Peer from 'simple-peer';
import play from 'play-dl';
import ffmpeg from 'ffmpeg-static';
import { spawn } from 'child_process';

const { RTCAudioSource } = nonstandard;

// Initialize SoundCloud client ID on startup
let soundcloudReady = false;
(async () => {
    try {
        const clientId = await play.getFreeClientID();
        await play.setToken({
            soundcloud: {
                client_id: clientId
            }
        });
        soundcloudReady = true;
        console.log("[MusicBot] SoundCloud initialized successfully");
    } catch (err) {
        console.error("[MusicBot] Failed to initialize SoundCloud:", err.message);
    }
})();

class MusicBot {
    constructor(io, broadcastRoomUpdate) {
        this.io = io;
        this.broadcastRoomUpdate = broadcastRoomUpdate;
        this.peers = {};
        this.currentRoom = null;
        this.audioSource = null;
        this.ffmpegProcess = null;
        this.isPlaying = false;
        this.botId = "music-bot";
        this.botName = "Music Bot";
        
        this.queue = [];
        this.currentTrack = null;
        this.textRoomId = null;
        this.currentStream = null;
        this.streamReady = false;
    }

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
        this.streamReady = false;
        
        Object.values(this.peers).forEach(peer => {
            try { peer.destroy(); } catch(e) {}
        });
        this.peers = {};
        this.currentRoom = null;
    }

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

    async addToQueue(query, textRoomId, voiceRoomId) {
        this.textRoomId = textRoomId;
        this.join(voiceRoomId);
        
        try {
            let searchQuery = query;
            
            if (query.includes("youtube.com") || query.includes("youtu.be")) {
                searchQuery = query
                    .replace(/https?:\/\/(www\.)?(youtube\.com|youtu\.be|music\.youtube\.com)\/(watch\?v=|shorts\/)?/gi, '')
                    .replace(/[&?].*$/g, '')
                    .replace(/[-_]/g, ' ')
                    .trim();
                if (searchQuery.length < 3) searchQuery = query;
            }

            this.sendMessage(`Araniyor: ${searchQuery}`);
            
            let track = null;
            
            // Try SoundCloud
            if (soundcloudReady) {
                try {
                    const scResults = await play.search(searchQuery, { 
                        source: { soundcloud: "tracks" }, 
                        limit: 1 
                    });
                    if (scResults.length > 0) {
                        track = {
                            title: scResults[0].name || scResults[0].title || searchQuery,
                            url: scResults[0].url,
                            duration: scResults[0].durationInSec || 0
                        };
                        console.log(`[MusicBot] Found on SoundCloud: ${track.title}`);
                    }
                } catch (scErr) {
                    console.log("[MusicBot] SoundCloud search failed:", scErr.message);
                }
            }
            
            // Try YouTube search -> SoundCloud
            if (!track) {
                try {
                    const ytResults = await play.search(searchQuery, { 
                        source: { youtube: "video" }, 
                        limit: 1 
                    });
                    if (ytResults.length > 0) {
                        const ytTitle = ytResults[0].title;
                        console.log(`[MusicBot] Found on YouTube: ${ytTitle}`);
                        const scResults = await play.search(ytTitle, { 
                            source: { soundcloud: "tracks" }, 
                            limit: 1 
                        });
                        if (scResults.length > 0) {
                            track = {
                                title: scResults[0].name || scResults[0].title || ytTitle,
                                url: scResults[0].url,
                                duration: scResults[0].durationInSec || 0
                            };
                        }
                    }
                } catch (ytErr) {
                    console.log("[MusicBot] YouTube fallback failed:", ytErr.message);
                }
            }
            
            if (!track) {
                this.sendMessage(`Bulunamadi: ${searchQuery}`);
                return false;
            }

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
            this.sendMessage(`Hata: ${err.message}`);
            return false;
        }
    }

    async playNext() {
        if (this.queue.length === 0) {
            this.sendMessage("Sira bitti.");
            this.isPlaying = false;
            this.streamReady = false;
            return;
        }

        this.currentTrack = this.queue[0];
        
        try {
            console.log(`[MusicBot] Playing: ${this.currentTrack.title}`);
            console.log(`[MusicBot] URL: ${this.currentTrack.url}`);
            
            const streamInfo = await play.stream(this.currentTrack.url, {
                discordPlayerCompatibility: true
            });
            console.log(`[MusicBot] Stream type: ${streamInfo.type}`);

            // Create audio source
            this.audioSource = new RTCAudioSource();
            const audioTrack = this.audioSource.createTrack();
            this.currentStream = new pkg.MediaStream([audioTrack]);
            
            // Start FFmpeg
            this.startFFmpeg(streamInfo.stream);
            
            this.isPlaying = true;
            this.streamReady = true;
            
            console.log(`[MusicBot] Stream ready, connecting to ${Object.keys(this.peers).length} peers`);

            // Add stream to all existing peers
            for (const [peerId, peer] of Object.entries(this.peers)) {
                try {
                    if (peer.connected || peer._pc) {
                        peer.addStream(this.currentStream);
                        console.log(`[MusicBot] Added stream to peer ${peerId}`);
                    }
                } catch (e) {
                    console.error(`[MusicBot] Error adding stream to ${peerId}:`, e.message);
                }
            }

        } catch (err) {
            console.error("[MusicBot] Play error:", err.message);
            this.sendMessage(`Calinamadi: ${this.currentTrack?.title || 'Unknown'}`);
            this.queue.shift();
            if (this.queue.length > 0) {
                await this.playNext();
            }
        }
    }

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

    getQueueList() {
        if (this.queue.length === 0) return "Sira bos.";
        let list = "Siradaki sarkilar:\n";
        this.queue.forEach((track, index) => {
            const prefix = index === 0 ? "(Simdi)" : `#${index + 1}`;
            list += `${prefix} ${track.title}\n`;
        });
        return list;
    }

    stopMusic() {
        console.log("[MusicBot] Stopping music");
        if (this.ffmpegProcess) {
            try {
                this.ffmpegProcess.kill('SIGKILL');
            } catch(e) {}
            this.ffmpegProcess = null;
        }
        this.audioSource = null;
        this.isPlaying = false;
        this.streamReady = false;
        
        if (this.currentStream) {
            for (const peer of Object.values(this.peers)) {
                try { peer.removeStream(this.currentStream); } catch (e) {}
            }
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

        // Buffer system: RTCAudioSource expects exactly 1920 bytes (10ms of audio)
        // 48000 Hz * 2 channels * 2 bytes per sample * 0.01 seconds = 1920 bytes
        const FRAME_SIZE = 1920;
        let audioBuffer = Buffer.alloc(0);
        let packetCount = 0;

        this.ffmpegProcess.stdout.on('data', (chunk) => {
            if (!this.audioSource) return;
            
            // Append new data to buffer
            audioBuffer = Buffer.concat([audioBuffer, chunk]);
            
            // Process complete frames
            while (audioBuffer.length >= FRAME_SIZE) {
                const frame = audioBuffer.slice(0, FRAME_SIZE);
                audioBuffer = audioBuffer.slice(FRAME_SIZE);
                
                if (packetCount < 3) {
                    console.log(`[FFmpeg] Sending frame: ${frame.length} bytes`);
                }
                packetCount++;
                
                try {
                    const samples = new Int16Array(frame.buffer, frame.byteOffset, frame.length / 2);
                    this.audioSource.onData({
                        samples,
                        sampleRate: 48000,
                        bitsPerSample: 16,
                        channelCount: 2
                    });
                } catch (err) {
                    console.error(`[FFmpeg] onData error: ${err.message}`);
                }
            }
        });

        this.ffmpegProcess.stderr.on('data', (data) => {
            // Debug only
        });

        this.ffmpegProcess.on('close', (code) => {
            console.log(`[FFmpeg] Exited: ${code}`);
            if (this.isPlaying && this.queue.length > 0) {
                this.queue.shift();
                this.playNext();
            }
        });

        this.ffmpegProcess.on('error', (err) => {
            console.error(`[FFmpeg] Error: ${err.message}`);
        });
    }

    initiateConnection(userSocketId) {
        if (!this.currentRoom) return;
        if (this.peers[userSocketId]) {
            console.log(`[MusicBot] Already connected to ${userSocketId}`);
            return;
        }

        console.log(`[MusicBot] Initiating connection to ${userSocketId}, streamReady: ${this.streamReady}`);

        const peer = new Peer({
            initiator: true,
            trickle: false,  // IMPORTANT: Match client settings
            wrtc: pkg,
            stream: this.streamReady ? this.currentStream : undefined,
            config: {
                iceServers: [
                    { urls: 'stun:stun.l.google.com:19302' },
                    { urls: 'stun:global.stun.twilio.com:3478' }
                ]
            }
        });

        this.peers[userSocketId] = peer;

        peer.on('signal', (signal) => {
            console.log(`[MusicBot] Sending signal to ${userSocketId}`);
            this.io.to(userSocketId).emit('user-joined-voice', {
                signal: signal,
                callerID: this.botId,
                username: this.botName
            });
        });

        peer.on('connect', () => {
            console.log(`[MusicBot] Connected to ${userSocketId}`);
            // If stream wasn't ready before, add it now
            if (this.streamReady && this.currentStream) {
                try {
                    peer.addStream(this.currentStream);
                    console.log(`[MusicBot] Added stream after connect to ${userSocketId}`);
                } catch(e) {
                    console.log(`[MusicBot] Stream already added or error: ${e.message}`);
                }
            }
        });

        peer.on('close', () => {
            console.log(`[MusicBot] Peer closed: ${userSocketId}`);
            delete this.peers[userSocketId];
        });

        peer.on('error', (err) => {
            console.error(`[MusicBot] Peer error ${userSocketId}:`, err.message);
            delete this.peers[userSocketId];
        });
    }

    handleSignal(userSocketId, signal) {
        if (!this.currentRoom) {
            console.log(`[MusicBot] Ignoring signal, not in room`);
            return;
        }

        console.log(`[MusicBot] Handling signal from ${userSocketId}`);

        if (this.peers[userSocketId]) {
            try {
                this.peers[userSocketId].signal(signal);
            } catch(e) {
                console.error(`[MusicBot] Signal error: ${e.message}`);
            }
        } else {
            const peer = new Peer({
                initiator: false,
                trickle: false,  // IMPORTANT: Match client settings
                wrtc: pkg,
                stream: this.streamReady ? this.currentStream : undefined,
                config: {
                    iceServers: [
                        { urls: 'stun:stun.l.google.com:19302' },
                        { urls: 'stun:global.stun.twilio.com:3478' }
                    ]
                }
            });

            this.peers[userSocketId] = peer;

            peer.on('signal', (outSignal) => {
                console.log(`[MusicBot] Returning signal to ${userSocketId}`);
                this.io.to(userSocketId).emit('receiving-returned-signal', {
                    signal: outSignal,
                    id: this.botId
                });
            });

            peer.on('connect', () => {
                console.log(`[MusicBot] Connected to ${userSocketId} (responder)`);
                if (this.streamReady && this.currentStream) {
                    try {
                        peer.addStream(this.currentStream);
                    } catch(e) {}
                }
            });

            peer.on('close', () => {
                delete this.peers[userSocketId];
            });

            peer.on('error', (err) => {
                console.error(`[MusicBot] Peer error:`, err.message);
                delete this.peers[userSocketId];
            });

            try {
                peer.signal(signal);
            } catch(e) {
                console.error(`[MusicBot] Initial signal error: ${e.message}`);
            }
        }
    }

    removePeer(socketId) {
        if (this.peers[socketId]) {
            try { this.peers[socketId].destroy(); } catch(e) {}
            delete this.peers[socketId];
        }
    }
}

export default MusicBot;
