import React from 'react';
import { useCurrentFrame, useVideoConfig } from 'remotion';

type FloatStyle = 'bob' | 'float' | 'pulse' | 'shake' | 'rotate-slow' | 'bounce';

interface FloatingElementProps {
  children: React.ReactNode;
  style?: FloatStyle;
  amplitude?: number;   // px for translate, scale units for pulse
  speed?: number;       // cycles per second (default 0.5)
  phaseOffset?: number; // phase shift in radians, for staggering multiple elements
  style_?: React.CSSProperties;
}

/**
 * Wraps any element with a subtle looping animation.
 * Used to make flat illustrations feel alive without full character rigging.
 */
export const FloatingElement: React.FC<FloatingElementProps> = ({
  children,
  style: floatStyle = 'bob',
  amplitude = 10,
  speed = 0.5,
  phaseOffset = 0,
  style_,
}) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();

  const t = (frame / fps) * Math.PI * 2 * speed + phaseOffset;

  let transform = '';

  switch (floatStyle) {
    case 'bob':
      // Gentle up/down
      transform = `translateY(${Math.sin(t) * amplitude}px)`;
      break;
    case 'float':
      // Bob + very subtle horizontal drift
      transform = `translate(${Math.sin(t * 0.7) * amplitude * 0.3}px, ${Math.sin(t) * amplitude}px)`;
      break;
    case 'pulse':
      // Scale in/out — breathing
      const pscale = 1 + Math.sin(t) * (amplitude * 0.005);
      transform = `scale(${pscale})`;
      break;
    case 'shake':
      // Rapid horizontal vibration — urgency/danger
      transform = `translateX(${Math.sin(t * 6) * amplitude * 0.5}px) rotate(${Math.sin(t * 4) * 1}deg)`;
      break;
    case 'rotate-slow':
      // Slow continuous rotation — coin spin, loading
      const deg = ((frame / fps) * 360 * speed * 0.25) % 360;
      transform = `rotate(${deg}deg)`;
      break;
    case 'bounce':
      // One-way bounce (like a ball) — only goes up, snaps back
      const bounceT = Math.abs(Math.sin(t));
      transform = `translateY(${-bounceT * amplitude}px)`;
      break;
    default:
      transform = '';
  }

  return (
    <div style={{ display: 'inline-block', transform, willChange: 'transform', ...style_ }}>
      {children}
    </div>
  );
};
