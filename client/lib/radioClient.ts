// Thin client wrapper over the radio module's REST + socket events.
// Kept deliberately independent from the music client code in page.tsx.

import type { Socket } from "socket.io-client";

export interface RadioStation {
  id: string;
  name: string;
  category: string;
  city?: string;
  country?: string;
  streamUrl: string;
  homepage?: string;
  enabled: boolean;
  priority: number;
}

export type RadioStatus =
  | "idle"
  | "connecting"
  | "playing"
  | "reconnecting"
  | "error"
  | "stopping";

export interface RadioState {
  voiceRoomId: string;
  roomId: string;
  status: RadioStatus;
  station: {
    id: string;
    name: string;
    category: string;
    homepage?: string;
  } | null;
  volume: number;
  isMuted: boolean;
  retryCount: number;
  error: string | null;
}

export const RADIO_CATEGORIES = [
  "pop",
  "turkce-pop",
  "arabesk",
  "haber",
  "ekonomi",
  "talk"
] as const;

export type RadioCategory = (typeof RADIO_CATEGORIES)[number];

export async function fetchStations(
  apiBase: string,
  category?: string
): Promise<RadioStation[]> {
  const url = new URL(`${apiBase}/api/radio/stations`);
  if (category) url.searchParams.set("category", category);
  const res = await fetch(url.toString());
  if (!res.ok) return [];
  const data = await res.json();
  return Array.isArray(data?.stations) ? data.stations : [];
}

export async function fetchRadioHealth(apiBase: string): Promise<{
  enabled: boolean;
  activeSessions: number;
} | null> {
  try {
    const res = await fetch(`${apiBase}/api/radio/health`);
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

export async function fetchRadioState(
  apiBase: string,
  roomId: string
): Promise<RadioState | null> {
  try {
    const res = await fetch(`${apiBase}/api/radio/state/${encodeURIComponent(roomId)}`);
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

export function emitRadioControl(
  socket: Socket | null,
  payload: {
    roomId: string;
    action: "play" | "stop" | "next" | "prev" | "volume" | "mute" | "unmute";
    stationId?: string;
    value?: number;
  }
): void {
  if (!socket) return;
  socket.emit("radio-control", payload);
}
