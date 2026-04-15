'use client';

import { useId } from 'react';

interface AutocompleteInputProps {
  value: string;
  onChange: (value: string) => void;
  suggestions: string[];
  placeholder?: string;
  className?: string;
  style?: React.CSSProperties;
  disabled?: boolean;
  required?: boolean;
  onKeyDown?: (e: React.KeyboardEvent<HTMLInputElement>) => void;
}

/**
 * A text input with a native <datalist> for autocomplete.
 * Pass suggestions from getRecentNiches() / getRecentTopics() for system-wide history.
 */
export function AutocompleteInput({
  value,
  onChange,
  suggestions,
  placeholder,
  className = 'input-field',
  style,
  disabled,
  required,
  onKeyDown,
}: AutocompleteInputProps) {
  const id = useId();
  const listId = `acl-${id.replace(/:/g, '')}`;

  return (
    <>
      <input
        value={value}
        onChange={e => onChange(e.target.value)}
        placeholder={placeholder}
        className={className}
        style={style}
        disabled={disabled}
        required={required}
        onKeyDown={onKeyDown}
        list={suggestions.length > 0 ? listId : undefined}
        autoComplete="off"
      />
      {suggestions.length > 0 && (
        <datalist id={listId}>
          {suggestions.map(s => (
            <option key={s} value={s} />
          ))}
        </datalist>
      )}
    </>
  );
}
