"use client";

import { useRef, ReactNode } from 'react';
import '@/app/spotlight.css';

interface SpotlightCardProps {
  children: React.ReactNode;
  className?: string;
  spotlightColor?: string;
  onClick?: () => void;
  onMouseEnter?: () => void;
}

const SpotlightCard: React.FC<SpotlightCardProps> = ({ 
  children, 
  className = "", 
  spotlightColor = "rgba(255, 255, 255, 0.25)",
  onClick,
  onMouseEnter
}) => {
  return (
    <div 
      className={`relative overflow-hidden rounded-xl bg-zinc-900 border border-zinc-800 ${className}`}
      onClick={onClick}
      onMouseEnter={onMouseEnter}
    >
      <div className="absolute inset-0 z-0 transition-opacity duration-500 opacity-0 hover:opacity-100">
        <div 
          className="absolute inset-0 blur-3xl"
          style={{ background: `radial-gradient(circle at center, ${spotlightColor}, transparent 70%)` }}
        />
      </div>
      <div className="relative z-10 h-full">
        {children}
      </div>
    </div>
  );
};

export default SpotlightCard;

