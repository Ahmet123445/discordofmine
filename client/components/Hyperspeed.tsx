"use client";

import { useEffect, useRef } from "react";

interface HyperspeedProps {
  effectOptions?: {
    onSpeedUp?: () => void;
    onSlowDown?: () => void;
    distortion?: string;
    length?: number;
    roadWidth?: number;
    islandWidth?: number;
    lanesPerRoad?: number;
    fov?: number;
    fovSpeedUp?: number;
    speedUp?: number;
    carLightsFade?: number;
    totalSideLightSticks?: number;
    lightPairsPerRoadWay?: number;
    shoulderLinesWidthPercentage?: number;
    brokenLinesWidthPercentage?: number;
    brokenLinesLengthPercentage?: number;
    lightStickWidth?: number[];
    lightStickHeight?: number[];
    movingAwaySpeed?: number[];
    movingCloserSpeed?: number[];
    carLightsLength?: number[];
    carLightsRadius?: number[];
    carWidthPercentage?: number[];
    carShiftX?: number[];
    carFloorSeparation?: number[];
    colors?: {
      roadColor?: number;
      islandColor?: number;
      background?: number;
      shoulderLines?: number;
      brokenLines?: number;
      leftCars?: number[];
      rightCars?: number[];
      sticks?: number;
    };
  };
}

const Hyperspeed: React.FC<HyperspeedProps> = ({ effectOptions = {} }) => {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const options = {
      onSpeedUp: () => {},
      onSlowDown: () => {},
      distortion: "turbulentDistortion",
      length: 400,
      roadWidth: 10,
      islandWidth: 2,
      lanesPerRoad: 4,
      fov: 90,
      fovSpeedUp: 150,
      speedUp: 2,
      carLightsFade: 0.4,
      totalSideLightSticks: 20,
      lightPairsPerRoadWay: 40,
      shoulderLinesWidthPercentage: 0.05,
      brokenLinesWidthPercentage: 0.1,
      brokenLinesLengthPercentage: 0.5,
      lightStickWidth: [0.12, 0.5],
      lightStickHeight: [1.3, 1.7],
      movingAwaySpeed: [60, 80],
      movingCloserSpeed: [-120, -160],
      carLightsLength: [400 * 0.03, 400 * 0.2],
      carLightsRadius: [0.05, 0.14],
      carWidthPercentage: [0.3, 0.5],
      carShiftX: [-0.8, 0.8],
      carFloorSeparation: [0, 5],
      colors: {
        roadColor: 0x080808,
        islandColor: 0x0a0a0a,
        background: 0x000000,
        shoulderLines: 0x131318,
        brokenLines: 0x131318,
        leftCars: [0xff102a, 0xEB383E, 0xff102a],
        rightCars: [0xdadafa, 0xd8888b, 0xdadafa],
        sticks: 0xdadafa,
      },
      ...effectOptions,
    };

    let animationFrameId: number;
    let time = 0;

    // Helper classes for the 3D projection
    class Vector3 {
      x: number;
      y: number;
      z: number;
      constructor(x: number, y: number, z: number) {
        this.x = x;
        this.y = y;
        this.z = z;
      }
    }

    // Warp Speed / Starfield Logic (Simplified for performance & style)
    // Replacing the complex Three.js shader logic often found in these libraries with a pure Canvas starfield warp
    // that matches the visual request of "Hyperspeed" background.
    
    let stars: { x: number; y: number; z: number; o: number }[] = [];
    let count = 800;
    const warpSpeed = 0;
    
    // Initialize stars
    for(let i=0; i<count; i++){
        stars.push({
            x: Math.random() * 1600 - 800,
            y: Math.random() * 900 - 450,
            z: Math.random() * 1000,
            o: Math.random()
        });
    }

    const resize = () => {
      canvas.width = window.innerWidth;
      canvas.height = window.innerHeight;
    };

    window.addEventListener('resize', resize);
    resize();

    const cx = canvas.width / 2;
    const cy = canvas.height / 2;

    const render = () => {
      ctx.fillStyle = "rgba(0, 0, 0, 1)";
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      
      const cx = canvas.width / 2;
      const cy = canvas.height / 2;

      // Speed control
      const speed = 5;

      stars.forEach(star => {
          // Move star towards camera (z decreases)
          star.z -= speed;
          
          // Reset if passed camera
          if (star.z <= 0) {
              star.z = 1000;
              star.x = Math.random() * 1600 - 800;
              star.y = Math.random() * 900 - 450;
          }

          // Projection
          const k = 128.0 / star.z;
          const px = star.x * k + cx;
          const py = star.y * k + cy;

          if (px >= 0 && px <= canvas.width && py >= 0 && py <= canvas.height) {
              const size = (1 - star.z / 1000) * 3;
              const shade = Math.floor((1 - star.z / 1000) * 255);
              
              // Draw Star
              ctx.fillStyle = `rgb(${shade}, ${shade}, ${255})`;
              ctx.beginPath();
              ctx.arc(px, py, size, 0, Math.PI * 2);
              ctx.fill();
              
              // Draw Trail (Hyperspeed effect)
              if (size > 1.5) {
                  ctx.beginPath();
                  ctx.strokeStyle = `rgba(${shade}, ${shade}, ${255}, 0.2)`;
                  ctx.lineWidth = size;
                  ctx.moveTo(px, py);
                  
                  // Calculate previous position for trail
                  const prevZ = star.z + speed * 4; 
                  const prevK = 128.0 / prevZ;
                  const prevX = star.x * prevK + cx;
                  const prevY = star.y * prevK + cy;
                  
                  ctx.lineTo(prevX, prevY);
                  ctx.stroke();
              }
          }
      });

      animationFrameId = requestAnimationFrame(render);
    };

    render();

    return () => {
      window.removeEventListener('resize', resize);
      cancelAnimationFrame(animationFrameId);
    };
  }, [effectOptions]);

  return <canvas ref={canvasRef} className="fixed inset-0 w-full h-full pointer-events-none" />;
};

export default Hyperspeed;
