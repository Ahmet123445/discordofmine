// SDP mutation helpers for the radio bot's outbound audio track.
// Used via simple-peer's `sdpTransform` hook so the local offer advertises
// Opus settings that yield the best quality at modest bandwidth and keeps
// audio prioritized when the user is also sharing screen or webcam.

// Opus fmtp parameters we want to force:
//   stereo=1;sprop-stereo=1      - enable stereo decoder
//   maxaveragebitrate=96000      - target ~96 kbps average
//   maxplaybackrate=48000        - 48 kHz full-band
//   useinbandfec=1               - FEC resilience for packet loss
//   usedtx=0                     - never gate silence (we pump silence ourselves)
const OPUS_PARAMS = {
  stereo: "1",
  "sprop-stereo": "1",
  maxaveragebitrate: "96000",
  maxplaybackrate: "48000",
  useinbandfec: "1",
  usedtx: "0"
};

// Upper bound (in kbps) advertised on the audio m-line. This is a hint;
// libwebrtc may still run below depending on congestion. 96 kbps matches the
// Opus target; 8 kbps of RTP overhead lands us around 104 kbps wire.
const AUDIO_BANDWIDTH_KBPS = 96;

const findOpusPayloadTypes = (lines) => {
  const pts = new Set();
  for (const line of lines) {
    // a=rtpmap:<pt> opus/48000/2
    const m = line.match(/^a=rtpmap:(\d+)\s+opus\//i);
    if (m) pts.add(m[1]);
  }
  return pts;
};

const ensureFmtpKv = (existing, next) => {
  const merged = { ...existing };
  for (const [k, v] of Object.entries(next)) {
    merged[k] = v;
  }
  return Object.entries(merged)
    .map(([k, v]) => `${k}=${v}`)
    .join(";");
};

const parseFmtp = (line) => {
  // a=fmtp:<pt> k1=v1;k2=v2
  const m = line.match(/^a=fmtp:(\d+)\s+(.*)$/);
  if (!m) return null;
  const kv = {};
  for (const pair of m[2].split(";")) {
    const [k, v] = pair.split("=");
    if (k) kv[k.trim()] = (v || "").trim();
  }
  return { pt: m[1], kv };
};

export const applyRadioAudioPreferences = (sdp) => {
  if (typeof sdp !== "string" || sdp.length === 0) return sdp;

  const lines = sdp.split(/\r?\n/);
  const opusPts = findOpusPayloadTypes(lines);
  if (opusPts.size === 0) return sdp;

  const out = [];
  let inAudioSection = false;
  let audioBandwidthInjected = false;
  const seenFmtpForPt = new Set();

  for (let i = 0; i < lines.length; i++) {
    let line = lines[i];

    if (line.startsWith("m=")) {
      inAudioSection = line.startsWith("m=audio");
      audioBandwidthInjected = false;
      out.push(line);
      continue;
    }

    // Inject b=AS right after c= line in the audio m-section.
    if (inAudioSection && !audioBandwidthInjected && line.startsWith("c=")) {
      out.push(line);
      out.push(`b=AS:${AUDIO_BANDWIDTH_KBPS}`);
      out.push(`b=TIAS:${AUDIO_BANDWIDTH_KBPS * 1000}`);
      audioBandwidthInjected = true;
      continue;
    }

    // Merge Opus params into existing fmtp line.
    if (line.startsWith("a=fmtp:")) {
      const parsed = parseFmtp(line);
      if (parsed && opusPts.has(parsed.pt)) {
        const nextKv = ensureFmtpKv(parsed.kv, OPUS_PARAMS);
        out.push(`a=fmtp:${parsed.pt} ${nextKv}`);
        seenFmtpForPt.add(parsed.pt);
        continue;
      }
    }

    out.push(line);
  }

  // For Opus payload types that had no fmtp line at all, append one.
  if (seenFmtpForPt.size !== opusPts.size) {
    // Find the last rtpmap:<opusPt> line and inject fmtp just after it.
    const finalLines = [];
    for (const line of out) {
      finalLines.push(line);
      const m = line.match(/^a=rtpmap:(\d+)\s+opus\//i);
      if (m && !seenFmtpForPt.has(m[1])) {
        const kv = ensureFmtpKv({}, OPUS_PARAMS);
        finalLines.push(`a=fmtp:${m[1]} ${kv}`);
        seenFmtpForPt.add(m[1]);
      }
    }
    return finalLines.join("\r\n");
  }

  return out.join("\r\n");
};
