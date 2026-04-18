"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import type { Socket } from "socket.io-client";
import {
  emitRadioControl,
  fetchStations,
  fetchRadioState,
  RADIO_CATEGORIES,
  type RadioCategory,
  type RadioState,
  type RadioStation
} from "../lib/radioClient";
import "./RadioPanel.css";

interface RadioPanelProps {
  socket: Socket | null;
  roomId: string;
  apiBase: string;
}

const STATUS_LABEL: Record<string, string> = {
  idle: "Beklemede",
  connecting: "Bağlanıyor...",
  playing: "Yayında",
  reconnecting: "Yeniden bağlanıyor...",
  error: "Hata",
  stopping: "Durduruluyor..."
};

const CATEGORY_LABEL: Record<RadioCategory, string> = {
  pop: "Pop",
  "turkce-pop": "Türkçe Pop",
  arabesk: "Arabesk",
  haber: "Haber",
  ekonomi: "Ekonomi",
  talk: "Talk"
};

export default function RadioPanel({ socket, roomId, apiBase }: RadioPanelProps) {
  const [stations, setStations] = useState<RadioStation[]>([]);
  const [category, setCategory] = useState<RadioCategory | "all">("all");
  const [state, setState] = useState<RadioState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [collapsed, setCollapsed] = useState(true);
  const [loading, setLoading] = useState(false);

  // Load station list (one-shot; categories change filters client-side).
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    fetchStations(apiBase)
      .then((list) => {
        if (!cancelled) setStations(list);
      })
      .finally(() => !cancelled && setLoading(false));
    return () => {
      cancelled = true;
    };
  }, [apiBase]);

  // Initial state snapshot + live radio-state updates.
  useEffect(() => {
    if (!roomId) return;
    let cancelled = false;
    fetchRadioState(apiBase, roomId).then((snap) => {
      if (!cancelled && snap) setState(snap);
    });
    return () => {
      cancelled = true;
    };
  }, [apiBase, roomId]);

  useEffect(() => {
    if (!socket) return;
    const onState = (s: RadioState) => {
      if (!s || s.roomId !== roomId) return;
      setState(s);
    };
    const onError = (p: { error: string }) => {
      setError(p?.error || "Radyo kontrolu basarisiz.");
      window.setTimeout(() => setError(null), 4000);
    };
    socket.on("radio-state", onState);
    socket.on("radio-control-error", onError);
    return () => {
      socket.off("radio-state", onState);
      socket.off("radio-control-error", onError);
    };
  }, [socket, roomId]);

  const filtered = useMemo(() => {
    if (category === "all") return stations;
    return stations.filter((s) => s.category === category);
  }, [stations, category]);

  const play = useCallback(
    (stationId: string) => {
      emitRadioControl(socket, { roomId, action: "play", stationId });
    },
    [socket, roomId]
  );

  const stop = useCallback(() => {
    emitRadioControl(socket, { roomId, action: "stop" });
  }, [socket, roomId]);

  const next = useCallback(() => {
    emitRadioControl(socket, { roomId, action: "next" });
  }, [socket, roomId]);

  const prev = useCallback(() => {
    emitRadioControl(socket, { roomId, action: "prev" });
  }, [socket, roomId]);

  const setVolume = useCallback(
    (value: number) => {
      emitRadioControl(socket, { roomId, action: "volume", value });
    },
    [socket, roomId]
  );

  const toggleMute = useCallback(() => {
    emitRadioControl(socket, {
      roomId,
      action: state?.isMuted ? "unmute" : "mute"
    });
  }, [socket, roomId, state?.isMuted]);

  const isActive = !!state && state.status !== "idle";

  return (
    <div className={`radio-panel ${collapsed ? "is-collapsed" : "is-open"}`}>
      <div className="radio-panel__head" onClick={() => setCollapsed((v) => !v)}>
        <div className="radio-panel__head-left">
          <span className="radio-panel__dot" data-status={state?.status || "idle"} />
          <strong>Radyo</strong>
          {state?.station ? (
            <span className="radio-panel__head-station">
              {state.station.name} — {STATUS_LABEL[state.status] || state.status}
            </span>
          ) : (
            <span className="radio-panel__head-station muted">Kapalı</span>
          )}
        </div>
        <button
          type="button"
          className="radio-panel__toggle"
          onClick={(e) => {
            e.stopPropagation();
            setCollapsed((v) => !v);
          }}
        >
          {collapsed ? "Aç" : "Gizle"}
        </button>
      </div>

      {!collapsed && (
        <div className="radio-panel__body">
          {error && <div className="radio-panel__error">{error}</div>}

          <div className="radio-panel__controls">
            <button type="button" onClick={prev} disabled={!isActive}>◀ Önceki</button>
            <button type="button" onClick={next} disabled={!isActive}>Sonraki ▶</button>
            <button
              type="button"
              onClick={toggleMute}
              disabled={!isActive}
              className={state?.isMuted ? "is-muted" : ""}
            >
              {state?.isMuted ? "Sesi Aç" : "Sustur"}
            </button>
            <button type="button" onClick={stop} disabled={!isActive} className="danger">
              Durdur
            </button>
            <input
              type="range"
              min={0}
              max={200}
              step={5}
              value={state?.volume ?? 40}
              onChange={(e) => setVolume(Number(e.target.value))}
              disabled={!isActive}
              title="Ses"
              className="radio-panel__volume"
            />
            <span className="radio-panel__volume-label">{state?.volume ?? 40}%</span>
          </div>

          <div className="radio-panel__filters">
            <button
              type="button"
              className={category === "all" ? "active" : ""}
              onClick={() => setCategory("all")}
            >
              Tümü
            </button>
            {RADIO_CATEGORIES.map((c) => (
              <button
                key={c}
                type="button"
                className={category === c ? "active" : ""}
                onClick={() => setCategory(c)}
              >
                {CATEGORY_LABEL[c]}
              </button>
            ))}
          </div>

          <div className="radio-panel__stations">
            {loading && <div className="radio-panel__empty">Yükleniyor...</div>}
            {!loading && filtered.length === 0 && (
              <div className="radio-panel__empty">Bu kategori için istasyon yok.</div>
            )}
            {filtered.map((s) => {
              const isCurrent = state?.station?.id === s.id;
              return (
                <button
                  key={s.id}
                  type="button"
                  className={`radio-station ${isCurrent ? "is-current" : ""}`}
                  onClick={() => play(s.id)}
                  title={s.streamUrl}
                >
                  <span className="radio-station__name">{s.name}</span>
                  <span className="radio-station__meta">
                    {CATEGORY_LABEL[s.category as RadioCategory] || s.category}
                    {s.city ? ` • ${s.city}` : ""}
                  </span>
                  {isCurrent && <span className="radio-station__badge">●</span>}
                </button>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}
