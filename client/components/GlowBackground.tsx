"use client";

import { useEffect, useRef } from "react";

const GlowBackground: React.FC = () => {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    let animationFrameId: number;
    let time = 0;

    const resize = () => {
      canvas.width = window.innerWidth;
      canvas.height = window.innerHeight;
    };

    window.addEventListener("resize", resize);
    resize();

    // Orbs/Blobs configuration
    const orbs = [
      { x: 0.3, y: 0.3, radius: 0.4, color: [139, 92, 246], speed: 0.0003 }, // Purple
      { x: 0.7, y: 0.6, radius: 0.35, color: [59, 130, 246], speed: 0.0004 }, // Blue
      { x: 0.5, y: 0.8, radius: 0.3, color: [236, 72, 153], speed: 0.0005 }, // Pink
      { x: 0.2, y: 0.7, radius: 0.25, color: [16, 185, 129], speed: 0.00035 }, // Green
    ];

    const render = () => {
      time += 1;
      
      // Clear with black
      ctx.fillStyle = "rgba(0, 0, 0, 1)";
      ctx.fillRect(0, 0, canvas.width, canvas.height);

      // Draw each orb
      orbs.forEach((orb, i) => {
        // Animate position slightly
        const offsetX = Math.sin(time * orb.speed + i) * 50;
        const offsetY = Math.cos(time * orb.speed * 1.3 + i) * 50;
        
        const x = orb.x * canvas.width + offsetX;
        const y = orb.y * canvas.height + offsetY;
        const radius = orb.radius * Math.min(canvas.width, canvas.height);

        // Create radial gradient
        const gradient = ctx.createRadialGradient(x, y, 0, x, y, radius);
        gradient.addColorStop(0, `rgba(${orb.color[0]}, ${orb.color[1]}, ${orb.color[2]}, 0.4)`);
        gradient.addColorStop(0.5, `rgba(${orb.color[0]}, ${orb.color[1]}, ${orb.color[2]}, 0.1)`);
        gradient.addColorStop(1, `rgba(${orb.color[0]}, ${orb.color[1]}, ${orb.color[2]}, 0)`);

        ctx.fillStyle = gradient;
        ctx.beginPath();
        ctx.arc(x, y, radius, 0, Math.PI * 2);
        ctx.fill();
      });

      // Add noise/grain overlay
      const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
      const data = imageData.data;
      for (let i = 0; i < data.length; i += 4) {
        const noise = (Math.random() - 0.5) * 15;
        data[i] = Math.max(0, Math.min(255, data[i] + noise));
        data[i + 1] = Math.max(0, Math.min(255, data[i + 1] + noise));
        data[i + 2] = Math.max(0, Math.min(255, data[i + 2] + noise));
      }
      ctx.putImageData(imageData, 0, 0);

      animationFrameId = requestAnimationFrame(render);
    };

    render();

    return () => {
      window.removeEventListener("resize", resize);
      cancelAnimationFrame(animationFrameId);
    };
  }, []);

  return (
    <canvas
      ref={canvasRef}
      className="fixed inset-0 w-full h-full pointer-events-none"
      style={{ filter: "blur(80px) saturate(1.5)" }}
    />
  );
};

export default GlowBackground;
