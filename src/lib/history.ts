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

export interface SeoHistoryEntry {
  id: string;
  timestamp: number;
  topic: string;
  niche: string;
  modelId: string;
  titlesCount: number;
  bestTitle: string;
  bestScore: number;
  tagsCount: number;
}

export interface ThumbnailHistoryEntry {
  id: string;
  timestamp: number;
  title: string;
  niche: string;
  modelId: string;
  conceptsCount: number;
  bestConceptName: string;
  bestScore: number;
  generatedImageUrl?: string;
}

const SCRIPT_KEY = 'script_history';
const IDEAS_KEY = 'ideas_history';
const VOICEOVER_KEY = 'voiceover_history';
const SEO_KEY = 'seo_history';
const THUMBNAIL_KEY = 'thumbnail_history';
const MAX_SCRIPT_ENTRIES = 50;
const MAX_IDEAS_ENTRIES = 100;
const MAX_VOICEOVER_ENTRIES = 100;
const MAX_SEO_ENTRIES = 50;
const MAX_THUMBNAIL_ENTRIES = 50;
const MAX_SCRIPT_LENGTH = 15000; // truncate very long scripts in history

function generateId(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 14)}`;
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
  if (typeof window === 'undefined') return;
  const history = getScriptHistory().filter(e => e.id !== id);
  safeSave(SCRIPT_KEY, JSON.stringify(history));
}

export function clearScriptHistory(): void {
  if (typeof window === 'undefined') return;
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
  if (typeof window === 'undefined') return;
  const history = getIdeasHistory().filter(e => e.id !== id);
  safeSave(IDEAS_KEY, JSON.stringify(history));
}

export function clearIdeasHistory(): void {
  if (typeof window === 'undefined') return;
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
  if (typeof window === 'undefined') return;
  const history = getVoiceoverHistory().filter(e => e.id !== id);
  safeSave(VOICEOVER_KEY, JSON.stringify(history));
}

// --- SEO ---

export function getSeoHistory(): SeoHistoryEntry[] {
  if (typeof window === 'undefined') return [];
  try { return JSON.parse(localStorage.getItem(SEO_KEY) || '[]'); } catch { return []; }
}

export function saveSeoEntry(entry: Omit<SeoHistoryEntry, 'id' | 'timestamp'>): SeoHistoryEntry {
  const full: SeoHistoryEntry = { ...entry, id: generateId(), timestamp: Date.now() };
  const history = getSeoHistory();
  history.unshift(full);
  if (history.length > MAX_SEO_ENTRIES) history.length = MAX_SEO_ENTRIES;
  safeSave(SEO_KEY, JSON.stringify(history));
  return full;
}

export function deleteSeoEntry(id: string): void {
  if (typeof window === 'undefined') return;
  safeSave(SEO_KEY, JSON.stringify(getSeoHistory().filter(e => e.id !== id)));
}

export function clearSeoHistory(): void { if (typeof window === 'undefined') return; localStorage.removeItem(SEO_KEY); }

// --- Thumbnails ---

export function getThumbnailHistory(): ThumbnailHistoryEntry[] {
  if (typeof window === 'undefined') return [];
  try { return JSON.parse(localStorage.getItem(THUMBNAIL_KEY) || '[]'); } catch { return []; }
}

export function saveThumbnailEntry(entry: Omit<ThumbnailHistoryEntry, 'id' | 'timestamp'>): ThumbnailHistoryEntry {
  const full: ThumbnailHistoryEntry = { ...entry, id: generateId(), timestamp: Date.now() };
  const history = getThumbnailHistory();
  history.unshift(full);
  if (history.length > MAX_THUMBNAIL_ENTRIES) history.length = MAX_THUMBNAIL_ENTRIES;
  safeSave(THUMBNAIL_KEY, JSON.stringify(history));
  return full;
}

export function deleteThumbnailEntry(id: string): void {
  if (typeof window === 'undefined') return;
  safeSave(THUMBNAIL_KEY, JSON.stringify(getThumbnailHistory().filter(e => e.id !== id)));
}

export function clearThumbnailHistory(): void { if (typeof window === 'undefined') return; localStorage.removeItem(THUMBNAIL_KEY); }

export function clearVoiceoverHistory(): void { if (typeof window === 'undefined') return; localStorage.removeItem(VOICEOVER_KEY); }

// --- QA Engine ---

export interface QAHistoryEntry {
  id: string;
  timestamp: number;
  niche: string;
  aggressiveness: string;
  modelId: string;
  scriptPreview: string;
  overallScore: number;
  verdict: string;
  passCount: number;
  // Full payload needed to actually resume a session. Older entries written
  // before these fields existed are restored from `scriptPreview` only.
  script?: string;
  result?: unknown;
}

const QA_KEY = 'qa_history';
const MAX_QA_ENTRIES = 50;

export function getQAHistory(): QAHistoryEntry[] {
  if (typeof window === 'undefined') return [];
  try { return JSON.parse(localStorage.getItem(QA_KEY) || '[]'); } catch { return []; }
}

export function saveQAEntry(entry: Omit<QAHistoryEntry, 'id' | 'timestamp'>): QAHistoryEntry {
  const full: QAHistoryEntry = { ...entry, id: generateId(), timestamp: Date.now() };
  const history = getQAHistory();
  history.unshift(full);
  if (history.length > MAX_QA_ENTRIES) history.length = MAX_QA_ENTRIES;
  safeSave(QA_KEY, JSON.stringify(history));
  return full;
}

export function deleteQAEntry(id: string): void {
  if (typeof window === 'undefined') return;
  safeSave(QA_KEY, JSON.stringify(getQAHistory().filter(e => e.id !== id)));
}

export function clearQAHistory(): void { if (typeof window === 'undefined') return; localStorage.removeItem(QA_KEY); }

// --- Production Doc ---

export interface ProductionDocHistoryEntry {
  id: string;
  timestamp: number;
  title: string;
  niche: string;
  topic: string;
  modelId: string;
  shotCount: number;
  totalDuration: string;
  totalWords: number;
  stylePreset: string;
}

const PROD_DOC_KEY = 'production_doc_history';
const MAX_PROD_DOC_ENTRIES = 30;

export function getProductionDocHistory(): ProductionDocHistoryEntry[] {
  if (typeof window === 'undefined') return [];
  try { return JSON.parse(localStorage.getItem(PROD_DOC_KEY) || '[]'); } catch { return []; }
}

export function saveProductionDocEntry(entry: Omit<ProductionDocHistoryEntry, 'id' | 'timestamp'>): ProductionDocHistoryEntry {
  const full: ProductionDocHistoryEntry = { ...entry, id: generateId(), timestamp: Date.now() };
  const history = getProductionDocHistory();
  history.unshift(full);
  if (history.length > MAX_PROD_DOC_ENTRIES) history.length = MAX_PROD_DOC_ENTRIES;
  safeSave(PROD_DOC_KEY, JSON.stringify(history));
  return full;
}

export function deleteProductionDocEntry(id: string): void {
  if (typeof window === 'undefined') return;
  safeSave(PROD_DOC_KEY, JSON.stringify(getProductionDocHistory().filter(e => e.id !== id)));
}

export function clearProductionDocHistory(): void { if (typeof window === 'undefined') return; localStorage.removeItem(PROD_DOC_KEY); }

// --- Aggregate autocomplete helpers ---

/** Returns unique niche strings from all history sources, ordered by recency. */
export function getRecentNiches(): string[] {
  if (typeof window === 'undefined') return [];
  const seen = new Set<string>();
  const results: string[] = [];
  const add = (v: string | undefined) => {
    if (!v?.trim()) return;
    const norm = v.trim();
    if (!seen.has(norm.toLowerCase())) { seen.add(norm.toLowerCase()); results.push(norm); }
  };
  getScriptHistory().forEach(e => add(e.niche));
  getIdeasHistory().forEach(e => add(e.niche));
  getSeoHistory().forEach(e => add(e.niche));
  getThumbnailHistory().forEach(e => add(e.niche));
  getQAHistory().forEach(e => add(e.niche));
  getProductionDocHistory().forEach(e => add(e.niche));
  return results.slice(0, 30);
}

/** Returns unique topic strings from all history sources, ordered by recency. */
export function getRecentTopics(): string[] {
  if (typeof window === 'undefined') return [];
  const seen = new Set<string>();
  const results: string[] = [];
  const add = (v: string | undefined) => {
    if (!v?.trim()) return;
    const norm = v.trim();
    if (!seen.has(norm.toLowerCase())) { seen.add(norm.toLowerCase()); results.push(norm); }
  };
  getScriptHistory().forEach(e => add(e.topic));
  getSeoHistory().forEach(e => add(e.topic));
  getThumbnailHistory().forEach(e => add(e.title));
  getProductionDocHistory().forEach(e => add(e.topic));
  return results.slice(0, 30);
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
    (e.ideas || []).filter(Boolean).some(i =>
      String(i?.title || '').toLowerCase().includes(q) ||
      String(i?.hook || '').toLowerCase().includes(q)
    )
  );
}
