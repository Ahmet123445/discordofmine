// Radio audio constants. Values deliberately mirror server/index.js music
// constants (48kHz / stereo / s16le / 10ms frames) but are redefined here so
// the radio module has zero code-level coupling to the music bot.

export const AUDIO_SAMPLE_RATE = 48000;
export const AUDIO_CHANNEL_COUNT = 2;
export const AUDIO_BITS_PER_SAMPLE = 16;
export const AUDIO_BYTES_PER_SAMPLE = AUDIO_BITS_PER_SAMPLE / 8;

const parsedFrameDuration = Number(process.env.RADIO_FRAME_DURATION_MS || process.env.MUSIC_FRAME_DURATION_MS || 10);
export const FRAME_DURATION_MS =
  Number.isFinite(parsedFrameDuration) && parsedFrameDuration >= 10 && parsedFrameDuration <= 60
    ? Math.round(parsedFrameDuration)
    : 10;

export const FRAME_SAMPLES_PER_CHANNEL = Math.max(
  1,
  Math.round((AUDIO_SAMPLE_RATE * FRAME_DURATION_MS) / 1000)
);
export const FRAME_SIZE_BYTES =
  FRAME_SAMPLES_PER_CHANNEL * AUDIO_CHANNEL_COUNT * AUDIO_BYTES_PER_SAMPLE;

export const RADIO_PREBUFFER_FRAMES = Number(process.env.RADIO_PREBUFFER_FRAMES || 72);
export const RADIO_REBUFFER_FRAMES = Number(process.env.RADIO_REBUFFER_FRAMES || 40);
export const RADIO_MAX_CATCHUP_FRAMES = Number(process.env.RADIO_MAX_CATCHUP_FRAMES || 4);

export const SILENCE_SAMPLES = new Int16Array(FRAME_SIZE_BYTES / 2);

export const RADIO_BOT_USERNAME = "Radio Bot";
