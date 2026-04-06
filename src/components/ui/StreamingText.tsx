'use client';

import { useEffect, useRef, useState } from 'react';
import ReactMarkdown from 'react-markdown';

interface StreamingTextProps {
  text: string;
  isStreaming?: boolean;
  className?: string;
  renderMarkdown?: boolean;
}

export function StreamingText({ text, isStreaming = false, className = '', renderMarkdown = false }: StreamingTextProps) {
  if (!text) return null;

  if (renderMarkdown) {
    return (
      <div className={`prose-dark ${className} ${isStreaming ? 'cursor-blink' : ''}`}>
        <ReactMarkdown>{text}</ReactMarkdown>
      </div>
    );
  }

  return (
    <pre
      className={`whitespace-pre-wrap font-sans text-sm leading-relaxed ${className} ${isStreaming ? 'cursor-blink' : ''}`}
      style={{ color: 'var(--text-secondary)' }}
    >
      {text}
    </pre>
  );
}
