import React from 'react';
import { useCurrentFrame, useVideoConfig, spring, interpolate } from 'remotion';
import { SPRING_SNAPPY, SPRING_BOUNCY } from '../animations/spring-presets';
import { BrandKit } from '../types';

type TitleVariant = 'slide-up' | 'slide-down' | 'zoom-in' | 'fade' | 'pop';

interface AnimatedTitleProps {
  text: string;
  brand: BrandKit;
  variant?: TitleVariant;
  fontSize?: number;
  color?: string;
  delay?: number;           // Delay in frames before animation starts
  textAlign?: 'left' | 'center' | 'right';
  uppercase?: boolean;
  letterSpacing?: number;
  shadow?: boolean;
}

/**
 * Animated title text component.
 * Springs into frame on scene start. Used for bold section headers
 * in the style of educational YouTube channels.
 */
export const AnimatedTitle: React.FC<AnimatedTitleProps> = ({
  text,
  brand,
  variant = 'slide-up',
  fontSize = 80,
  color,
  delay = 0,
  textAlign = 'center',
  uppercase = false,
  letterSpacing = -1,
  shadow = true,
}) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();

  const effectiveFrame = Math.max(0, frame - delay);

  const springValue = spring({
    frame: effectiveFrame,
    fps,
    config: variant === 'pop' ? SPRING_BOUNCY : SPRING_SNAPPY,
    from: 0,
    to: 1,
  });

  const opacity = interpolate(effectiveFrame, [0, 8], [0, 1], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' });

  let transform = '';
  switch (variant) {
    case 'slide-up':
      transform = `translateY(${(1 - springValue) * 60}px)`;
      break;
    case 'slide-down':
      transform = `translateY(${(1 - springValue) * -60}px)`;
      break;
    case 'zoom-in':
      transform = `scale(${0.7 + springValue * 0.3})`;
      break;
    case 'pop':
      transform = `scale(${springValue})`;
      break;
    case 'fade':
    default:
      transform = 'none';
      break;
  }

  const titleColor = color || brand.titleColor;

  return (
    <div
      style={{
        fontFamily: brand.titleFontFamily,
        fontSize,
        fontWeight: 900,
        color: titleColor,
        textAlign,
        letterSpacing,
        transform,
        opacity,
        textTransform: uppercase ? 'uppercase' : 'none',
        lineHeight: 1.1,
        willChange: 'transform, opacity',
        textShadow: shadow ? '0 2px 20px rgba(0,0,0,0.15)' : 'none',
        wordBreak: 'break-word',
      }}
    >
      {text}
    </div>
  );
};
