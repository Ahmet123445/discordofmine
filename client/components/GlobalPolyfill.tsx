// Fix for packages that rely on 'global' or 'process' (common in WebRTC libs)
if (typeof window !== "undefined") {
  if (window.global === undefined) {
    (window as any).global = window;
  }
  if (window.process === undefined) {
    (window as any).process = { env: {} };
  }
}

export default function GlobalPolyfill() {
  return null;
}
