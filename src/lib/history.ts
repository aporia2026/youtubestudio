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
  ideas: Array<{ title: string; hook: string; content_type: string; estimated_views_potential: string; trend_status: string }>;
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
const MAX_ENTRIES = 100;

function generateId(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

// --- Scripts ---

export function getScriptHistory(): ScriptHistoryEntry[] {
  if (typeof window === 'undefined') return [];
  try {
    return JSON.parse(localStorage.getItem(SCRIPT_KEY) || '[]');
  } catch { return []; }
}

export function saveScript(entry: Omit<ScriptHistoryEntry, 'id' | 'timestamp'>): ScriptHistoryEntry {
  const full: ScriptHistoryEntry = { ...entry, id: generateId(), timestamp: Date.now() };
  const history = getScriptHistory();
  history.unshift(full);
  if (history.length > MAX_ENTRIES) history.length = MAX_ENTRIES;
  localStorage.setItem(SCRIPT_KEY, JSON.stringify(history));
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
  if (history.length > MAX_ENTRIES) history.length = MAX_ENTRIES;
  localStorage.setItem(IDEAS_KEY, JSON.stringify(history));
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
  if (history.length > MAX_ENTRIES) history.length = MAX_ENTRIES;
  localStorage.setItem(VOICEOVER_KEY, JSON.stringify(history));
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
    e.script.toLowerCase().includes(q) ||
    e.tone.toLowerCase().includes(q) ||
    e.style.toLowerCase().includes(q)
  );
}

export function searchIdeas(query: string): IdeasHistoryEntry[] {
  const q = query.toLowerCase();
  return getIdeasHistory().filter(e =>
    e.niche.toLowerCase().includes(q) ||
    e.ideas.some(i =>
      i.title.toLowerCase().includes(q) ||
      i.hook.toLowerCase().includes(q)
    )
  );
}
