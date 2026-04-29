'use client';

import { useRef, useEffect, useState, useCallback, type RefObject } from 'react';

interface CanvasOverlayProps {
  videoRef: RefObject<HTMLVideoElement | null>;
  isActive: boolean;
  videoDims: { width: number; height: number };
  onComplete: (data: unknown, thumbnail: string) => void;
}

type DrawTool = 'freehand' | 'arrow' | 'rect' | 'text';

interface Point { x: number; y: number }

interface DrawObject {
  type: DrawTool;
  color: string;
  strokeWidth: number;
  // freehand
  points?: Point[];
  // arrow / rect
  start?: Point;
  end?: Point;
  // text
  position?: Point;
  text?: string;
}

const COLORS = ['#ef4444', '#f59e0b', '#22c55e', '#06b6d4', '#7c3aed', '#ffffff'];

export function CanvasOverlay({ videoRef, isActive, videoDims, onComplete }: CanvasOverlayProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const [tool, setTool] = useState<DrawTool>('freehand');
  const [color, setColor] = useState('#ef4444');
  const [strokeWidth, setStrokeWidth] = useState(3);
  const [objects, setObjects] = useState<DrawObject[]>([]);
  const [drawing, setDrawing] = useState(false);
  const [currentObject, setCurrentObject] = useState<DrawObject | null>(null);
  const [textInput, setTextInput] = useState<{ x: number; y: number } | null>(null);
  const [textValue, setTextValue] = useState('');
  const [canvasDims, setCanvasDims] = useState({ width: 0, height: 0 });

  // Resize canvas to match video display size
  useEffect(() => {
    if (!isActive) return;
    const video = videoRef.current;
    const container = containerRef.current;
    if (!video || !container) return;

    function updateSize() {
      const rect = video!.getBoundingClientRect();
      const parentRect = container!.parentElement!.getBoundingClientRect();
      setCanvasDims({
        width: rect.width,
        height: rect.height,
      });
      // Position canvas over video within the parent
      container!.style.left = `${rect.left - parentRect.left}px`;
      container!.style.top = `${rect.top - parentRect.top}px`;
      container!.style.width = `${rect.width}px`;
      container!.style.height = `${rect.height}px`;
    }

    updateSize();
    const observer = new ResizeObserver(updateSize);
    observer.observe(video);
    return () => observer.disconnect();
  }, [isActive, videoRef]);

  // Redraw canvas whenever objects change
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    canvas.width = canvasDims.width;
    canvas.height = canvasDims.height;
    ctx.clearRect(0, 0, canvas.width, canvas.height);

    // Scale factor from normalized (0-1) to canvas pixels
    const sx = canvasDims.width;
    const sy = canvasDims.height;

    function drawObj(obj: DrawObject) {
      ctx!.strokeStyle = obj.color;
      ctx!.fillStyle = obj.color;
      ctx!.lineWidth = obj.strokeWidth;
      ctx!.lineCap = 'round';
      ctx!.lineJoin = 'round';

      if (obj.type === 'freehand' && obj.points && obj.points.length > 1) {
        ctx!.beginPath();
        ctx!.moveTo(obj.points[0].x * sx, obj.points[0].y * sy);
        for (let i = 1; i < obj.points.length; i++) {
          ctx!.lineTo(obj.points[i].x * sx, obj.points[i].y * sy);
        }
        ctx!.stroke();
      }

      if (obj.type === 'rect' && obj.start && obj.end) {
        const x = obj.start.x * sx;
        const y = obj.start.y * sy;
        const w = (obj.end.x - obj.start.x) * sx;
        const h = (obj.end.y - obj.start.y) * sy;
        ctx!.strokeRect(x, y, w, h);
      }

      if (obj.type === 'arrow' && obj.start && obj.end) {
        const x1 = obj.start.x * sx, y1 = obj.start.y * sy;
        const x2 = obj.end.x * sx, y2 = obj.end.y * sy;
        ctx!.beginPath();
        ctx!.moveTo(x1, y1);
        ctx!.lineTo(x2, y2);
        ctx!.stroke();
        // Arrowhead
        const angle = Math.atan2(y2 - y1, x2 - x1);
        const headLen = 15;
        ctx!.beginPath();
        ctx!.moveTo(x2, y2);
        ctx!.lineTo(x2 - headLen * Math.cos(angle - Math.PI / 6), y2 - headLen * Math.sin(angle - Math.PI / 6));
        ctx!.moveTo(x2, y2);
        ctx!.lineTo(x2 - headLen * Math.cos(angle + Math.PI / 6), y2 - headLen * Math.sin(angle + Math.PI / 6));
        ctx!.stroke();
      }

      if (obj.type === 'text' && obj.position && obj.text) {
        const fontSize = Math.max(14, canvasDims.width * 0.025);
        ctx!.font = `bold ${fontSize}px sans-serif`;
        ctx!.fillStyle = obj.color;
        // Background
        const metrics = ctx!.measureText(obj.text);
        const tx = obj.position.x * sx;
        const ty = obj.position.y * sy;
        ctx!.fillStyle = 'rgba(0,0,0,0.6)';
        ctx!.fillRect(tx - 2, ty - fontSize, metrics.width + 4, fontSize + 4);
        ctx!.fillStyle = obj.color;
        ctx!.fillText(obj.text, tx, ty);
      }
    }

    for (const obj of objects) drawObj(obj);
    if (currentObject) drawObj(currentObject);
  }, [objects, currentObject, canvasDims]);

  // Get normalized coordinates from mouse event
  const getNorm = useCallback((e: React.MouseEvent): Point => {
    const canvas = canvasRef.current!;
    const rect = canvas.getBoundingClientRect();
    return {
      x: (e.clientX - rect.left) / rect.width,
      y: (e.clientY - rect.top) / rect.height,
    };
  }, []);

  const handleMouseDown = useCallback((e: React.MouseEvent) => {
    if (!isActive) return;
    const pt = getNorm(e);

    if (tool === 'text') {
      setTextInput(pt);
      setTextValue('');
      return;
    }

    setDrawing(true);
    if (tool === 'freehand') {
      setCurrentObject({ type: 'freehand', color, strokeWidth, points: [pt] });
    } else {
      setCurrentObject({ type: tool, color, strokeWidth, start: pt, end: pt });
    }
  }, [isActive, tool, color, strokeWidth, getNorm]);

  const handleMouseMove = useCallback((e: React.MouseEvent) => {
    if (!drawing || !currentObject) return;
    const pt = getNorm(e);

    if (currentObject.type === 'freehand') {
      setCurrentObject(prev => prev ? { ...prev, points: [...(prev.points || []), pt] } : null);
    } else {
      setCurrentObject(prev => prev ? { ...prev, end: pt } : null);
    }
  }, [drawing, currentObject, getNorm]);

  const handleMouseUp = useCallback(() => {
    if (!drawing || !currentObject) return;
    setDrawing(false);
    setObjects(prev => [...prev, currentObject]);
    setCurrentObject(null);
  }, [drawing, currentObject]);

  const handleTextSubmit = useCallback(() => {
    if (textInput && textValue.trim()) {
      setObjects(prev => [...prev, {
        type: 'text', color, strokeWidth, position: textInput, text: textValue.trim(),
      }]);
    }
    setTextInput(null);
    setTextValue('');
  }, [textInput, textValue, color, strokeWidth]);

  const handleUndo = useCallback(() => {
    setObjects(prev => prev.slice(0, -1));
  }, []);

  const handleClear = useCallback(() => {
    setObjects([]);
    setCurrentObject(null);
  }, []);

  const handleSave = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas || objects.length === 0) return;

    // Composite: draw video frame + annotations
    const compositeCanvas = document.createElement('canvas');
    compositeCanvas.width = videoDims.width || canvasDims.width;
    compositeCanvas.height = videoDims.height || canvasDims.height;
    const ctx = compositeCanvas.getContext('2d');
    if (!ctx) return;

    // Draw video frame
    if (videoRef.current) {
      ctx.drawImage(videoRef.current, 0, 0, compositeCanvas.width, compositeCanvas.height);
    }

    // Draw annotation canvas scaled to composite size
    ctx.drawImage(canvas, 0, 0, compositeCanvas.width, compositeCanvas.height);

    const thumbnail = compositeCanvas.toDataURL('image/png');
    const drawingData = { objects, videoDims };

    onComplete(drawingData, thumbnail);
    setObjects([]);
    setCurrentObject(null);
  }, [objects, videoDims, canvasDims, videoRef, onComplete]);

  if (!isActive) return null;

  return (
    <div ref={containerRef} className="absolute" style={{ zIndex: 10 }}>
      <canvas
        ref={canvasRef}
        width={canvasDims.width}
        height={canvasDims.height}
        onMouseDown={handleMouseDown}
        onMouseMove={handleMouseMove}
        onMouseUp={handleMouseUp}
        onMouseLeave={handleMouseUp}
        className="absolute inset-0"
        style={{ cursor: 'crosshair' }}
      />

      {/* Text input overlay */}
      {textInput && (
        <input
          autoFocus
          value={textValue}
          onChange={e => setTextValue(e.target.value)}
          onKeyDown={e => { if (e.key === 'Enter') handleTextSubmit(); if (e.key === 'Escape') setTextInput(null); }}
          onBlur={handleTextSubmit}
          className="absolute px-1 py-0.5 text-sm font-bold border-none outline-none"
          style={{
            left: `${textInput.x * 100}%`,
            top: `${textInput.y * 100}%`,
            color,
            background: 'rgba(0,0,0,0.5)',
            zIndex: 20,
          }}
        />
      )}

      {/* Toolbar */}
      <div
        className="absolute top-2 left-1/2 -translate-x-1/2 flex items-center gap-1 px-2 py-1 rounded-lg"
        style={{ background: 'rgba(0,0,0,0.8)', zIndex: 20 }}
      >
        {/* Tools */}
        {([
          { id: 'freehand' as const, label: 'Draw', icon: <path d="M17 3a2.828 2.828 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5L17 3z" /> },
          { id: 'arrow' as const, label: 'Arrow', icon: <><line x1="5" y1="12" x2="19" y2="12" /><polyline points="12 5 19 12 12 19" /></> },
          { id: 'rect' as const, label: 'Rectangle', icon: <rect x="3" y="3" width="18" height="18" rx="2" /> },
          { id: 'text' as const, label: 'Text', icon: <><polyline points="4 7 4 4 20 4 20 7" /><line x1="9" y1="20" x2="15" y2="20" /><line x1="12" y1="4" x2="12" y2="20" /></> },
        ]).map(t => (
          <button
            key={t.id}
            onClick={() => setTool(t.id)}
            className="p-1.5 rounded transition-colors"
            style={{ background: tool === t.id ? 'rgba(124,58,237,0.4)' : 'transparent' }}
            title={t.label}
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="2">{t.icon}</svg>
          </button>
        ))}

        <div className="w-px h-5 mx-1" style={{ background: 'rgba(255,255,255,0.2)' }} />

        {/* Colors */}
        {COLORS.map(c => (
          <button
            key={c}
            onClick={() => setColor(c)}
            className="w-4 h-4 rounded-full transition-transform"
            style={{
              background: c,
              transform: color === c ? 'scale(1.3)' : 'scale(1)',
              boxShadow: color === c ? `0 0 0 2px white` : 'none',
            }}
          />
        ))}

        <div className="w-px h-5 mx-1" style={{ background: 'rgba(255,255,255,0.2)' }} />

        {/* Stroke width */}
        <input
          type="range" min="1" max="8" value={strokeWidth}
          onChange={e => setStrokeWidth(parseInt(e.target.value))}
          className="w-12 accent-purple-500"
        />

        <div className="w-px h-5 mx-1" style={{ background: 'rgba(255,255,255,0.2)' }} />

        {/* Actions */}
        <button onClick={handleUndo} className="p-1.5 rounded hover:bg-white/10 transition-colors" title="Undo">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="2"><polyline points="1 4 1 10 7 10" /><path d="M3.51 15a9 9 0 1 0 2.13-9.36L1 10" /></svg>
        </button>
        <button onClick={handleClear} className="p-1.5 rounded hover:bg-white/10 transition-colors" title="Clear all">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="2"><path d="M3 6h18M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6" /></svg>
        </button>

        <div className="w-px h-5 mx-1" style={{ background: 'rgba(255,255,255,0.2)' }} />

        <button
          onClick={handleSave}
          disabled={objects.length === 0}
          className="px-2 py-1 rounded text-xs font-medium text-white disabled:opacity-30 transition-colors"
          style={{ background: '#22c55e' }}
        >
          Done
        </button>
      </div>
    </div>
  );
}
