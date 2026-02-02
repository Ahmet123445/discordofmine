/**
 * Noise Suppression Module using RNNoise WASM
 * 
 * This module provides real-time noise suppression for audio streams
 * using the @shiguredo/rnnoise-wasm library.
 * 
 * Requirements:
 * - Sample rate: 48000 Hz (RNNoise requirement)
 * - Mono audio (single channel)
 * - Frame size: 480 samples (10ms at 48kHz)
 */

import { Rnnoise, DenoiseState } from "@shiguredo/rnnoise-wasm";

const SCRIPT_PROCESSOR_BUFFER_SIZE = 512;
const INT16_MAX_VALUE = 0x7fff; // 32767

export class NoiseSuppressor {
  private rnnoise: Rnnoise | null = null;
  private denoiseState: DenoiseState | null = null;
  private audioContext: AudioContext | null = null;
  private scriptProcessor: ScriptProcessorNode | null = null;
  private sourceNode: MediaStreamAudioSourceNode | null = null;
  private destinationNode: MediaStreamAudioDestinationNode | null = null;
  private frameSize: number = 480;
  private accumulatedSamples: Float32Array;
  private accumulatedSamplesCount: number = 0;
  private isInitialized: boolean = false;
  private isProcessing: boolean = false;

  constructor() {
    this.accumulatedSamples = new Float32Array(SCRIPT_PROCESSOR_BUFFER_SIZE * 4);
  }

  /**
   * Initialize RNNoise WASM module
   * Must be called before createDenoisedStream
   */
  async init(): Promise<void> {
    if (this.isInitialized) {
      console.log("[NoiseSuppressor] Already initialized");
      return;
    }

    try {
      console.log("[NoiseSuppressor] Loading RNNoise WASM...");
      this.rnnoise = await Rnnoise.load();
      this.frameSize = this.rnnoise.frameSize; // Should be 480
      this.accumulatedSamples = new Float32Array(this.frameSize * 4);
      this.isInitialized = true;
      console.log(`[NoiseSuppressor] RNNoise loaded. Frame size: ${this.frameSize}`);
    } catch (error) {
      console.error("[NoiseSuppressor] Failed to load RNNoise:", error);
      throw error;
    }
  }

  /**
   * Create a denoised MediaStream from the original stream
   * The original stream should ideally be 48kHz mono
   */
  async createDenoisedStream(originalStream: MediaStream): Promise<MediaStream> {
    if (!this.isInitialized || !this.rnnoise) {
      throw new Error("[NoiseSuppressor] Not initialized. Call init() first.");
    }

    if (this.isProcessing) {
      console.warn("[NoiseSuppressor] Already processing. Stopping previous processing.");
      this.stopProcessing();
    }

    try {
      // Create AudioContext with 48kHz sample rate (RNNoise requirement)
      this.audioContext = new AudioContext({ 
        sampleRate: 48000,
        latencyHint: "interactive"
      });

      if (this.audioContext.state === "suspended") {
        await this.audioContext.resume();
      }

      console.log(`[NoiseSuppressor] AudioContext created. Sample rate: ${this.audioContext.sampleRate}`);

      // Create denoise state
      this.denoiseState = this.rnnoise.createDenoiseState();
      console.log("[NoiseSuppressor] Denoise state created");

      // Create source node from original stream
      this.sourceNode = this.audioContext.createMediaStreamSource(originalStream);

      // Create destination node for clean audio
      this.destinationNode = this.audioContext.createMediaStreamDestination();

      // Create script processor for audio processing
      // Note: ScriptProcessorNode is deprecated but AudioWorklet requires more complex setup
      // For now, ScriptProcessorNode works reliably for this use case
      this.scriptProcessor = this.audioContext.createScriptProcessor(
        SCRIPT_PROCESSOR_BUFFER_SIZE,
        1, // Input channels (mono)
        1  // Output channels (mono)
      );

      // Reset accumulator
      this.accumulatedSamplesCount = 0;

      // Audio processing callback
      this.scriptProcessor.onaudioprocess = (event: AudioProcessingEvent) => {
        if (!this.denoiseState || !this.isProcessing) return;

        const inputData = event.inputBuffer.getChannelData(0);
        const outputData = event.outputBuffer.getChannelData(0);

        // Accumulate samples until we have enough for a frame
        this.accumulateSamples(inputData);

        // Process complete frames
        let outputIndex = 0;
        while (this.accumulatedSamplesCount >= this.frameSize && outputIndex < outputData.length) {
          // Extract a frame
          const frame = this.accumulatedSamples.slice(0, this.frameSize);
          
          // Process frame with RNNoise
          const processedFrame = this.processFrame(frame);
          
          // Copy processed samples to output
          const samplesToWrite = Math.min(this.frameSize, outputData.length - outputIndex);
          for (let i = 0; i < samplesToWrite; i++) {
            outputData[outputIndex + i] = processedFrame[i];
          }
          outputIndex += samplesToWrite;

          // Shift accumulator
          this.accumulatedSamples.copyWithin(0, this.frameSize, this.accumulatedSamplesCount);
          this.accumulatedSamplesCount -= this.frameSize;
        }

        // If we didn't fill the output buffer completely, fill with zeros or last values
        while (outputIndex < outputData.length) {
          outputData[outputIndex] = inputData[outputIndex] || 0;
          outputIndex++;
        }
      };

      // Connect the audio graph
      this.sourceNode.connect(this.scriptProcessor);
      this.scriptProcessor.connect(this.destinationNode);

      // Also connect to a silent gain node to keep processing active
      const silentGain = this.audioContext.createGain();
      silentGain.gain.value = 0;
      this.scriptProcessor.connect(silentGain);
      silentGain.connect(this.audioContext.destination);

      this.isProcessing = true;
      console.log("[NoiseSuppressor] Audio processing chain connected");

      return this.destinationNode.stream;
    } catch (error) {
      console.error("[NoiseSuppressor] Failed to create denoised stream:", error);
      this.stopProcessing();
      throw error;
    }
  }

  /**
   * Accumulate samples for frame-based processing
   */
  private accumulateSamples(samples: Float32Array): void {
    // Check if we need to expand the buffer
    if (this.accumulatedSamplesCount + samples.length > this.accumulatedSamples.length) {
      // Shift data to make room
      const keepCount = Math.min(this.accumulatedSamplesCount, this.frameSize * 2);
      const shiftAmount = this.accumulatedSamplesCount - keepCount;
      if (shiftAmount > 0) {
        this.accumulatedSamples.copyWithin(0, shiftAmount, this.accumulatedSamplesCount);
        this.accumulatedSamplesCount = keepCount;
      }
    }

    // Add new samples
    this.accumulatedSamples.set(samples, this.accumulatedSamplesCount);
    this.accumulatedSamplesCount += samples.length;
  }

  /**
   * Process a single frame with RNNoise
   * Input: Float32Array in range [-1, 1]
   * Output: Float32Array in range [-1, 1] (denoised)
   */
  private processFrame(frame: Float32Array): Float32Array {
    if (!this.denoiseState) {
      return frame;
    }

    // Create a copy for processing (RNNoise modifies in place)
    const processingFrame = new Float32Array(this.frameSize);

    // Convert Float32 [-1, 1] to Int16 range [-32767, 32767]
    for (let i = 0; i < this.frameSize; i++) {
      processingFrame[i] = frame[i] * INT16_MAX_VALUE;
    }

    // Apply RNNoise denoising
    this.denoiseState.processFrame(processingFrame);

    // Convert back to Float32 [-1, 1]
    const result = new Float32Array(this.frameSize);
    for (let i = 0; i < this.frameSize; i++) {
      result[i] = Math.max(-1.0, Math.min(1.0, processingFrame[i] / INT16_MAX_VALUE));
    }

    return result;
  }

  /**
   * Stop processing and clean up resources
   */
  stopProcessing(): void {
    console.log("[NoiseSuppressor] Stopping processing...");

    this.isProcessing = false;

    if (this.scriptProcessor) {
      this.scriptProcessor.onaudioprocess = null;
      this.scriptProcessor.disconnect();
      this.scriptProcessor = null;
    }

    if (this.sourceNode) {
      this.sourceNode.disconnect();
      this.sourceNode = null;
    }

    if (this.destinationNode) {
      this.destinationNode = null;
    }

    if (this.denoiseState) {
      this.denoiseState.destroy();
      this.denoiseState = null;
    }

    if (this.audioContext && this.audioContext.state !== "closed") {
      this.audioContext.close().catch(() => {});
      this.audioContext = null;
    }

    this.accumulatedSamplesCount = 0;
    console.log("[NoiseSuppressor] Processing stopped");
  }

  /**
   * Completely destroy the suppressor
   */
  destroy(): void {
    this.stopProcessing();
    this.rnnoise = null;
    this.isInitialized = false;
    console.log("[NoiseSuppressor] Destroyed");
  }

  /**
   * Check if currently processing
   */
  isActive(): boolean {
    return this.isProcessing;
  }

  /**
   * Check if initialized
   */
  isReady(): boolean {
    return this.isInitialized;
  }
}

// Singleton instance for app-wide use
let globalSuppressor: NoiseSuppressor | null = null;

/**
 * Get or create the global NoiseSuppressor instance
 */
export async function getNoiseSuppressor(): Promise<NoiseSuppressor> {
  if (!globalSuppressor) {
    globalSuppressor = new NoiseSuppressor();
    await globalSuppressor.init();
  }
  return globalSuppressor;
}

/**
 * Destroy the global NoiseSuppressor instance
 */
export function destroyNoiseSuppressor(): void {
  if (globalSuppressor) {
    globalSuppressor.destroy();
    globalSuppressor = null;
  }
}
