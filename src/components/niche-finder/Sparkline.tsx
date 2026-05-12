'use client';

/**
 * Inline SVG sparkline. No charting library, no externalised
 * styling. Renders an array of numeric values as a polyline scaled
 * to the component's bounding box.
 *
 * Y-axis is normalised to the input's own min/max so even a small
 * absolute movement is visible. Single-point arrays render as a
 * centered dot.
 */
interface SparklineProps {
  values: readonly number[];
  width?: number;
  height?: number;
  stroke?: string;
  fillBelow?: boolean;
}

export function Sparkline({
  values,
  width = 140,
  height = 32,
  stroke = '#22c55e',
  fillBelow = true,
}: SparklineProps): React.ReactElement {
  if (values.length === 0) {
    return (
      <svg width={width} height={height} aria-hidden="true">
        <rect x={0} y={height / 2} width={width} height={1} fill="#334155" />
      </svg>
    );
  }
  const finite = values.filter((v) => Number.isFinite(v));
  if (finite.length === 0) {
    return <svg width={width} height={height} aria-hidden="true" />;
  }
  const min = Math.min(...finite);
  const max = Math.max(...finite);
  const span = max - min || 1;
  const stepX = finite.length > 1 ? width / (finite.length - 1) : 0;
  const padY = 2;
  const usable = height - padY * 2;
  const points = finite.map((v, i) => {
    const x = i * stepX;
    const y = padY + (1 - (v - min) / span) * usable;
    return `${x.toFixed(2)},${y.toFixed(2)}`;
  });

  if (finite.length === 1) {
    return (
      <svg width={width} height={height} aria-hidden="true">
        <circle cx={width / 2} cy={height / 2} r={2} fill={stroke} />
      </svg>
    );
  }

  return (
    <svg width={width} height={height} aria-hidden="true">
      {fillBelow && (
        <polygon
          points={`0,${height} ${points.join(' ')} ${width},${height}`}
          fill={stroke}
          fillOpacity={0.12}
        />
      )}
      <polyline
        points={points.join(' ')}
        fill="none"
        stroke={stroke}
        strokeWidth={1.5}
        strokeLinejoin="round"
        strokeLinecap="round"
      />
    </svg>
  );
}
