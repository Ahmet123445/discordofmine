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
        this.botName = "🎵 Music Bot";
    }

    // Join a voice room
    join(roomId) {
        if (this.currentRoom === roomId) return;
        if (this.currentRoom) this.leave();

        console.log(`[MusicBot] Joining room ${roomId}`);
        this.currentRoom = roomId;

        // Notify existing users in the room that bot has joined
        // We don't add to the global usersInVoice array directly here, 
        // the index.js will handle the "visual" list, but we need to trigger connection logic.
    }

    leave() {
        if (!this.currentRoom) return;
        
        console.log(`[MusicBot] Leaving room ${this.currentRoom}`);
        this.stopMusic();
        
        // Destroy all peers
        Object.values(this.peers).forEach(peer => peer.destroy());
        this.peers = {};
        this.currentRoom = null;
    }

    async play(url, roomId) {
        if (!url) return;
        
        // Ensure we are in the room
        this.join(roomId);

        // Stop current music if any
        this.stopMusic();

        try {
            console.log(`[MusicBot] Fetching info for: ${url}`);
            
            // Validate URL
            const validation = await play.validate(url);
            if (!validation) {
                console.error("[MusicBot] Invalid URL");
                return;
            }

            // Get Stream with discord optimization
            const streamInfo = await play.stream(url, {
                discordPlayerCompatibility: true,
                quality: 2 // High quality
            });
            console.log(`[MusicBot] Stream Type: ${streamInfo.type}`);

            // Initialize WebRTC Audio Source
            this.audioSource = new RTCAudioSource();
            const track = this.audioSource.createTrack();
            const mediaStream = new pkg.MediaStream([track]);

            // Start FFMPEG to convert stream to PCM
            this.startFFmpeg(streamInfo.stream, streamInfo.type);

            this.isPlaying = true;

            // Update all peers with the new stream
            // Since we are server-side, we might need to renegotiate or just replace track.
            // Simple-peer replaceTrack is tricky. 
            // Strategy: The peers should already be established with this stream or we add it.
            
            // For simplicity in this MVP: 
            // If peers exist, we might need to re-add stream. 
            // But usually, we create the peers *after* we have the stream or add stream later.
            
            // Let's store the stream to use for new connections
            this.currentStream = mediaStream;
            
            // If we already have peers, add this stream to them
            Object.values(this.peers).forEach(peer => {
                try {
                    peer.addStream(this.currentStream);
                } catch (e) {
                    console.error("Error adding stream to peer:", e);
                }
            });

        } catch (err) {
            console.error("[MusicBot] Play Error:", err);
            this.stopMusic();
        }
    }

    stopMusic() {
        if (this.ffmpegProcess) {
            this.ffmpegProcess.kill();
            this.ffmpegProcess = null;
        }
        if (this.audioSource) {
            // No direct stop method, but we stop feeding data
            this.audioSource = null;
        }
        this.isPlaying = false;
        
        // Remove stream from peers
        if (this.currentStream) {
            Object.values(this.peers).forEach(peer => {
                try {
                    peer.removeStream(this.currentStream);
                } catch (e) {}
            });
            this.currentStream = null;
        }
    }

    startFFmpeg(inputStream, inputType) {
        const args = [
            '-re', // Read input at native frame rate (crucial for streaming)
            '-i', '-', // Input from pipe
            '-f', 's16le', // Output format: signed 16-bit little-endian PCM
            '-ar', '48000', // Sample rate: 48k (WebRTC standard)
            '-ac', '2', // Channels: Stereo
            '-' // Output to pipe
        ];

        this.ffmpegProcess = spawn(ffmpeg, args);

        // Pipe input stream to ffmpeg
        inputStream.pipe(this.ffmpegProcess.stdin);

        // Read output from ffmpeg and feed to RTCAudioSource
        let packetCount = 0;
        this.ffmpegProcess.stdout.on('data', (chunk) => {
            if (this.audioSource) {
                // Log first few packets to confirm data is flowing
                if (packetCount < 5) {
                    console.log(`[FFmpeg] Received chunk size: ${chunk.length} bytes`);
                }
                packetCount++;
                
                const samples = new Int16Array(chunk.buffer, chunk.byteOffset, chunk.length / 2);
                this.audioSource.onData({
                    samples,
                    sampleRate: 48000,
                    bitsPerSample: 16,
                    channelCount: 2 // Explicitly state stereo
                });
            }
        });

        this.ffmpegProcess.stderr.on('data', (data) => {
             // Uncomment to see ffmpeg errors
             // console.log(`[FFmpeg Error] ${data.toString()}`); 
        });

        this.ffmpegProcess.on('close', (code) => {
            console.log(`[FFmpeg] Exited with code ${code}`);
            this.isPlaying = false;
        });
    }

    // Initiate connection to a specific user (Bot acts as joiner)
    initiateConnection(userSocketId) {
        if (!this.currentRoom || this.peers[userSocketId]) return;

        console.log(`[MusicBot] Initiating connection to ${userSocketId}`);

        const peer = new Peer({
            initiator: true,
            wrtc: pkg,
            stream: this.currentStream || null
        });

        this.peers[userSocketId] = peer;

        peer.on('signal', (signal) => {
            // Send signal to user as if bot joined
            this.io.to(userSocketId).emit('user-joined-voice', {
                signal: signal,
                callerID: this.botId,
                username: this.botName
            });
        });

        peer.on('connect', () => {
            console.log(`[MusicBot] Connected to ${userSocketId} (Initiator)`);
        });

        peer.on('close', () => {
            console.log(`[MusicBot] Disconnected from ${userSocketId}`);
            delete this.peers[userSocketId];
        });

        peer.on('error', (err) => {
            console.error(`[MusicBot] Peer Error with ${userSocketId}:`, err.message);
        });
    }

    // Handle incoming WebRTC signal from a user
    handleSignal(userSocketId, signal) {
        if (!this.currentRoom) return;

        console.log(`[MusicBot] Handling signal from ${userSocketId}`);

        if (this.peers[userSocketId]) {
            // Peer already exists, just signal
            this.peers[userSocketId].signal(signal);
        } else {
            // Create new peer for this user (User initiated)
            const peer = new Peer({
                initiator: false,
                wrtc: pkg,
                stream: this.currentStream || null // Attach stream if playing
            });

            this.peers[userSocketId] = peer;

            peer.on('signal', (outSignal) => {
                // Return signal to user
                this.io.to(userSocketId).emit('receiving-returned-signal', {
                    signal: outSignal,
                    id: this.botId // Client sees this as "bot ID"
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
                console.error(`[MusicBot] Peer Error with ${userSocketId}:`, err.message);
            });

            // Signal immediately
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
