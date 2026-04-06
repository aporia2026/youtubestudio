// Persistent history for generated scripts and ideas — stored in localStorage

export interface ScriptHistoryEntry {
  id: string;
  timestamp: number;
  topic: string;
  niche: string;
  tone: string;
  style: string;
  duration: number;
  modelId: string;
  script: string;
  wordCount: number;
}

export interface IdeasHistoryEntry {
  id: string;
  timestamp: number;
  niche: string;
  focus: string;
  videoType: string;
  modelId: string;
  count: number;
  ideas: Array<Record<string, unknown>>;
}

export interface VoiceoverHistoryEntry {
  id: string;
  timestamp: number;
  voiceName: string;
  voiceId: string;
  modelId: string;
  textPreview: string;
  charCount: number;
  audioUrl: string;
  tone: string;
  style: string;
}

const SCRIPT_KEY = 'script_history';
const IDEAS_KEY = 'ideas_history';
const VOICEOVER_KEY = 'voiceover_history';
const MAX_SCRIPT_ENTRIES = 50;
const MAX_IDEAS_ENTRIES = 100;
const MAX_VOICEOVER_ENTRIES = 100;
const MAX_SCRIPT_LENGTH = 15000; // truncate very long scripts in history

function generateId(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function safeSave(key: string, data: string): boolean {
  try {
    localStorage.setItem(key, data);
    return true;
  } catch {
    // Quota exceeded — remove oldest entries and retry
    try {
      const parsed = JSON.parse(data);
      if (Array.isArray(parsed) && parsed.length > 5) {
        parsed.length = Math.floor(parsed.length / 2);
        localStorage.setItem(key, JSON.stringify(parsed));
        return true;
      }
    } catch {}
    return false;
  }
}

// --- Scripts ---

export function getScriptHistory(): ScriptHistoryEntry[] {
  if (typeof window === 'undefined') return [];
  try {
    return JSON.parse(localStorage.getItem(SCRIPT_KEY) || '[]');
  } catch { return []; }
}

export function saveScript(entry: Omit<ScriptHistoryEntry, 'id' | 'timestamp'>): ScriptHistoryEntry {
  const scriptText = entry.script.length > MAX_SCRIPT_LENGTH
    ? entry.script.slice(0, MAX_SCRIPT_LENGTH) + '\n\n[... truncated in history ...]'
    : entry.script;
  const full: ScriptHistoryEntry = { ...entry, script: scriptText, id: generateId(), timestamp: Date.now() };
  const history = getScriptHistory();
  history.unshift(full);
  if (history.length > MAX_SCRIPT_ENTRIES) history.length = MAX_SCRIPT_ENTRIES;
  safeSave(SCRIPT_KEY, JSON.stringify(history));
  return full;
}

export function deleteScriptEntry(id: string): void {
  const history = getScriptHistory().filter(e => e.id !== id);
  localStorage.setItem(SCRIPT_KEY, JSON.stringify(history));
}

export function clearScriptHistory(): void {
  localStorage.removeItem(SCRIPT_KEY);
}

// --- Ideas ---

export function getIdeasHistory(): IdeasHistoryEntry[] {
  if (typeof window === 'undefined') return [];
  try {
    return JSON.parse(localStorage.getItem(IDEAS_KEY) || '[]');
  } catch { return []; }
}

export function saveIdeas(entry: Omit<IdeasHistoryEntry, 'id' | 'timestamp'>): IdeasHistoryEntry {
  const full: IdeasHistoryEntry = { ...entry, id: generateId(), timestamp: Date.now() };
  const history = getIdeasHistory();
  history.unshift(full);
  if (history.length > MAX_IDEAS_ENTRIES) history.length = MAX_IDEAS_ENTRIES;
  safeSave(IDEAS_KEY, JSON.stringify(history));
  return full;
}

export function deleteIdeasEntry(id: string): void {
  const history = getIdeasHistory().filter(e => e.id !== id);
  localStorage.setItem(IDEAS_KEY, JSON.stringify(history));
}

export function clearIdeasHistory(): void {
  localStorage.removeItem(IDEAS_KEY);
}

// --- Voiceovers ---

export function getVoiceoverHistory(): VoiceoverHistoryEntry[] {
  if (typeof window === 'undefined') return [];
  try {
    return JSON.parse(localStorage.getItem(VOICEOVER_KEY) || '[]');
  } catch { return []; }
}

export function saveVoiceover(entry: Omit<VoiceoverHistoryEntry, 'id' | 'timestamp'>): VoiceoverHistoryEntry {
  const full: VoiceoverHistoryEntry = { ...entry, id: generateId(), timestamp: Date.now() };
  const history = getVoiceoverHistory();
  history.unshift(full);
  if (history.length > MAX_VOICEOVER_ENTRIES) history.length = MAX_VOICEOVER_ENTRIES;
  safeSave(VOICEOVER_KEY, JSON.stringify(history));
  return full;
}

export function deleteVoiceoverEntry(id: string): void {
  const history = getVoiceoverHistory().filter(e => e.id !== id);
  localStorage.setItem(VOICEOVER_KEY, JSON.stringify(history));
}

// --- Search ---

export function searchScripts(query: string): ScriptHistoryEntry[] {
  const q = query.toLowerCase();
  return getScriptHistory().filter(e =>
    e.topic.toLowerCase().includes(q) ||
    e.niche.toLowerCase().includes(q) ||
    e.tone.toLowerCase().includes(q) ||
    e.style.toLowerCase().includes(q) ||
    e.script.slice(0, 500).toLowerCase().includes(q) // only search beginning, not full body
  );
}

export function searchIdeas(query: string): IdeasHistoryEntry[] {
  const q = query.toLowerCase();
  return getIdeasHistory().filter(e =>
    e.niche.toLowerCase().includes(q) ||
    e.ideas.some(i =>
      String(i.title || '').toLowerCase().includes(q) ||
      String(i.hook || '').toLowerCase().includes(q)
    )
  );
}
