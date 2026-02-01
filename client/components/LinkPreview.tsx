"use client";

import { useEffect, useState } from "react";

interface LinkPreviewProps {
  url: string;
}

interface PreviewData {
  title?: string;
  description?: string;
  image?: string;
  siteName?: string;
  favicon?: string;
}

export default function LinkPreview({ url }: LinkPreviewProps) {
  const [preview, setPreview] = useState<PreviewData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);

  useEffect(() => {
    const fetchPreview = async () => {
      try {
        const API_URL = process.env.NEXT_PUBLIC_API_URL || "http://localhost:3001";
        const res = await fetch(`${API_URL}/api/link-preview?url=${encodeURIComponent(url)}`);
        
        if (res.ok) {
          const data = await res.json();
          if (data.title || data.description || data.image) {
            setPreview(data);
          } else {
            setError(true);
          }
        } else {
          setError(true);
        }
      } catch (err) {
        console.error("Failed to fetch link preview:", err);
        setError(true);
      } finally {
        setLoading(false);
      }
    };

    fetchPreview();
  }, [url]);

  // Extract domain from URL
  const getDomain = (url: string) => {
    try {
      const urlObj = new URL(url);
      return urlObj.hostname.replace("www.", "");
    } catch {
      return url;
    }
  };

  if (loading) {
    return (
      <div className="mt-2 p-3 bg-zinc-900/50 rounded-lg border border-zinc-700/50 animate-pulse">
        <div className="h-4 bg-zinc-700 rounded w-3/4 mb-2"></div>
        <div className="h-3 bg-zinc-800 rounded w-1/2"></div>
      </div>
    );
  }

  if (error || !preview) {
    // Just show a simple link
    return (
      <a
        href={url}
        target="_blank"
        rel="noopener noreferrer"
        className="mt-1 text-indigo-400 hover:text-indigo-300 hover:underline text-sm break-all flex items-center gap-1"
      >
        <svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/>
          <polyline points="15 3 21 3 21 9"/>
          <line x1="10" y1="14" x2="21" y2="3"/>
        </svg>
        {getDomain(url)}
      </a>
    );
  }

  return (
    <a
      href={url}
      target="_blank"
      rel="noopener noreferrer"
      className="mt-2 block bg-zinc-900/80 rounded-lg border border-zinc-700/50 overflow-hidden hover:border-indigo-500/50 transition-colors group"
    >
      <div className="flex">
        {/* Image */}
        {preview.image && (
          <div className="w-24 h-24 flex-shrink-0 bg-zinc-800">
            <img
              src={preview.image}
              alt=""
              className="w-full h-full object-cover"
              onError={(e) => {
                (e.target as HTMLImageElement).style.display = "none";
              }}
            />
          </div>
        )}
        
        {/* Content */}
        <div className="flex-1 p-3 min-w-0">
          {/* Site name */}
          <div className="flex items-center gap-1.5 text-[10px] text-zinc-500 mb-1">
            {preview.favicon && (
              <img src={preview.favicon} alt="" className="w-3 h-3" onError={(e) => {
                (e.target as HTMLImageElement).style.display = "none";
              }} />
            )}
            <span>{preview.siteName || getDomain(url)}</span>
            <svg xmlns="http://www.w3.org/2000/svg" width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="opacity-0 group-hover:opacity-100 transition-opacity">
              <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/>
              <polyline points="15 3 21 3 21 9"/>
              <line x1="10" y1="14" x2="21" y2="3"/>
            </svg>
          </div>
          
          {/* Title */}
          {preview.title && (
            <h4 className="text-sm font-medium text-indigo-400 group-hover:text-indigo-300 truncate">
              {preview.title}
            </h4>
          )}
          
          {/* Description */}
          {preview.description && (
            <p className="text-xs text-zinc-400 mt-1 line-clamp-2">
              {preview.description}
            </p>
          )}
        </div>
      </div>
    </a>
  );
}
