// Deterministic competitor analytics — all numbers computed from real data.
// The AI layer is only allowed to *explain* these numbers, never invent them.

import { parseDurationSeconds, YT_CATEGORY_MAP } from './youtube';

export interface VideoRow {
  video_id: string;
  title: string;
  description: string | null;
  published_at: string;
  view_count: number;
  like_count: number;
  comment_count: number;
  duration: string;
  duration_seconds: number;
  category_id: string | null;
  tags: string[];
  top_comments?: { text: string; likeCount: number }[];
}

export interface CompetitorAnalytics {
  // --- Dataset shape ---
  dataset: {
    videoCount: number;
    oldestPublishedAt: string | null;
    newestPublishedAt: string | null;
    spanDays: number;
  };

  // --- Performance distribution ---
  performance: {
    medianViews: number;
    meanViews: number;
    p10Views: number;
    p90Views: number;
    stddevViews: number;
    medianEngagementRate: number; // (likes + comments) / views
    medianLikeRate: number;
    medianCommentRate: number;
  };

  // --- Upload cadence ---
  cadence: {
    uploadsPerWeek: number;
    medianGapDays: number;
    stddevGapDays: number;
    consistencyScore: number; // 0..1 (1 = perfectly regular)
    dayOfWeekHistogram: Record<string, number>; // Mon..Sun → count
    hourOfDayHistogram: Record<string, number>; // 0..23 → count
    bestDayByAvgViews: string | null;
    bestHourByAvgViews: number | null;
  };

  // --- Duration strategy ---
  duration: {
    buckets: {
      shorts: { count: number; avgViews: number; avgEngagement: number };    // ≤ 60s
      short: { count: number; avgViews: number; avgEngagement: number };     // 61s–5min
      medium: { count: number; avgViews: number; avgEngagement: number };    // 5–15min
      long: { count: number; avgViews: number; avgEngagement: number };      // 15–30min
      extended: { count: number; avgViews: number; avgEngagement: number };  // 30min+
    };
    bestBucket: string;
    worstBucket: string;
  };

  // --- Title patterns ---
  titles: {
    medianLength: number;
    pctWithQuestion: number;
    pctWithNumber: number;
    pctWithBrackets: number;  // [ ] ( ) — clickbait markers
    pctAllCaps: number;
    pctWithEmoji: number;
    topWordsOverall: { word: string; count: number }[];
    topWordsInTopPerformers: { word: string; count: number; topRate: number; bottomRate: number; lift: number }[];
    topWordsInBottomPerformers: { word: string; count: number }[];
  };

  // --- Tag / keyword strategy ---
  tags: {
    avgTagsPerVideo: number;
    topTags: { tag: string; count: number; avgViews: number }[];
    tagsInTopPerformers: { tag: string; count: number }[];
    tagsInBottomPerformers: { tag: string; count: number }[];
  };

  // --- Description strategy ---
  descriptions: {
    medianLength: number;
    pctWithHashtags: number;
    pctWithLinks: number;
    pctWithChapters: number;
    avgHashtagsPerVideo: number;
  };

  // --- Category mix ---
  categories: { label: string; count: number; avgViews: number }[];

  // --- Cohorts ---
  topPerformers: VideoRow[];    // top 10% by views
  bottomPerformers: VideoRow[]; // bottom 10% by views
  outliers: VideoRow[];         // videos ≥3x median

  // --- Trend ---
  trend: {
    // rolling 4-video average views, ordered oldest→newest
    rollingAvgViews: { date: string; avg: number }[];
    firstHalfAvgViews: number;
    secondHalfAvgViews: number;
    momentum: 'accelerating' | 'declining' | 'steady';
    momentumPct: number;
  };
}

// ---------------- helpers ----------------

function percentile(sorted: number[], p: number): number {
  if (!sorted.length) return 0;
  const idx = Math.floor((sorted.length - 1) * p);
  return sorted[idx];
}

function mean(arr: number[]): number {
  return arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : 0;
}

function stddev(arr: number[]): number {
  if (arr.length < 2) return 0;
  const m = mean(arr);
  const variance = arr.reduce((sum, x) => sum + (x - m) ** 2, 0) / arr.length;
  return Math.sqrt(variance);
}

function tokenizeTitle(title: string): string[] {
  return title
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .split(/\s+/)
    .filter(w => w.length >= 3 && !STOPWORDS.has(w));
}

const STOPWORDS = new Set([
  'the','and','for','you','are','but','not','with','this','that','from','have','has','was','were','your','what','how','why','who','when','where','which','about','into','out','all','any','can','will','just','more','much','very','too','also','new','now','get','got','make','made','one','two','three','like','her','his','its','our','their','them','they','she','him','had','been','being','than','then','them'
]);

const DOW_NAMES = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];

function classifyDuration(sec: number): 'shorts'|'short'|'medium'|'long'|'extended' {
  if (sec <= 60) return 'shorts';
  if (sec <= 300) return 'short';
  if (sec <= 900) return 'medium';
  if (sec <= 1800) return 'long';
  return 'extended';
}

function hasChapters(desc: string): boolean {
  // Looks for timestamps like "0:00" on their own line
  return /(^|\n)\s*\d{1,2}:\d{2}(:\d{2})?\s+\S/.test(desc);
}

function countHashtags(text: string): number {
  return (text.match(/#\w+/g) || []).length;
}

function countLinks(text: string): number {
  return (text.match(/https?:\/\/\S+/g) || []).length;
}

// ---------------- main ----------------

export function computeAnalytics(videos: VideoRow[]): CompetitorAnalytics {
  const vids = videos.map(v => ({
    ...v,
    duration_seconds: v.duration_seconds || parseDurationSeconds(v.duration),
    tags: Array.isArray(v.tags) ? v.tags : [],
    description: v.description || '',
  }));

  const n = vids.length || 1;
  const views = vids.map(v => v.view_count).sort((a, b) => a - b);
  const medianViews = percentile(views, 0.5);
  const meanViews = mean(views);
  const p10 = percentile(views, 0.1);
  const p90 = percentile(views, 0.9);

  const engagement = vids.map(v => v.view_count ? (v.like_count + v.comment_count) / v.view_count : 0).sort((a, b) => a - b);
  const likeRates = vids.map(v => v.view_count ? v.like_count / v.view_count : 0).sort((a, b) => a - b);
  const commentRates = vids.map(v => v.view_count ? v.comment_count / v.view_count : 0).sort((a, b) => a - b);

  // --- cadence ---
  const byDate = [...vids].sort((a, b) => new Date(a.published_at).getTime() - new Date(b.published_at).getTime());
  const oldest = byDate[0]?.published_at || null;
  const newest = byDate[byDate.length - 1]?.published_at || null;
  const spanDays = oldest && newest ? Math.max(1, Math.round((new Date(newest).getTime() - new Date(oldest).getTime()) / 86400000)) : 0;
  const uploadsPerWeek = spanDays > 0 ? (n / spanDays) * 7 : 0;

  const gaps: number[] = [];
  for (let i = 1; i < byDate.length; i++) {
    gaps.push((new Date(byDate[i].published_at).getTime() - new Date(byDate[i - 1].published_at).getTime()) / 86400000);
  }
  const medianGap = percentile([...gaps].sort((a, b) => a - b), 0.5);
  const gapStd = stddev(gaps);
  const consistencyScore = medianGap > 0 ? Math.max(0, Math.min(1, 1 - (gapStd / (medianGap * 2)))) : 0;

  const dowHist: Record<string, number> = Object.fromEntries(DOW_NAMES.map(d => [d, 0]));
  const hourHist: Record<string, number> = Object.fromEntries(Array.from({ length: 24 }, (_, i) => [String(i), 0]));
  const dowViewTotals: Record<string, { sum: number; count: number }> = Object.fromEntries(DOW_NAMES.map(d => [d, { sum: 0, count: 0 }]));
  const hourViewTotals: Record<string, { sum: number; count: number }> = Object.fromEntries(Array.from({ length: 24 }, (_, i) => [String(i), { sum: 0, count: 0 }]));

  for (const v of vids) {
    const d = new Date(v.published_at);
    const dow = DOW_NAMES[d.getUTCDay()];
    const hour = String(d.getUTCHours());
    dowHist[dow]++;
    hourHist[hour]++;
    dowViewTotals[dow].sum += v.view_count;
    dowViewTotals[dow].count++;
    hourViewTotals[hour].sum += v.view_count;
    hourViewTotals[hour].count++;
  }

  const bestDay = Object.entries(dowViewTotals)
    .filter(([, v]) => v.count >= 2)
    .sort((a, b) => (b[1].sum / b[1].count) - (a[1].sum / a[1].count))[0]?.[0] || null;
  const bestHourEntry = Object.entries(hourViewTotals)
    .filter(([, v]) => v.count >= 2)
    .sort((a, b) => (b[1].sum / b[1].count) - (a[1].sum / a[1].count))[0];
  const bestHour = bestHourEntry ? parseInt(bestHourEntry[0]) : null;

  // --- duration buckets ---
  type Bucket = { count: number; viewSum: number; engSum: number };
  const buckets: Record<string, Bucket> = {
    shorts: { count: 0, viewSum: 0, engSum: 0 },
    short: { count: 0, viewSum: 0, engSum: 0 },
    medium: { count: 0, viewSum: 0, engSum: 0 },
    long: { count: 0, viewSum: 0, engSum: 0 },
    extended: { count: 0, viewSum: 0, engSum: 0 },
  };
  for (const v of vids) {
    const b = buckets[classifyDuration(v.duration_seconds)];
    b.count++;
    b.viewSum += v.view_count;
    b.engSum += v.view_count ? (v.like_count + v.comment_count) / v.view_count : 0;
  }
  const bucketStats = Object.fromEntries(
    Object.entries(buckets).map(([k, b]) => [k, {
      count: b.count,
      avgViews: b.count ? Math.round(b.viewSum / b.count) : 0,
      avgEngagement: b.count ? b.engSum / b.count : 0,
    }]),
  );
  const bucketsRanked = Object.entries(bucketStats)
    .filter(([, s]) => (s as { count: number }).count >= 2)
    .sort((a, b) => (b[1] as { avgViews: number }).avgViews - (a[1] as { avgViews: number }).avgViews);
  const bestBucket = bucketsRanked[0]?.[0] || 'medium';
  const worstBucket = bucketsRanked[bucketsRanked.length - 1]?.[0] || 'medium';

  // --- title patterns ---
  const titles = vids.map(v => v.title);
  const titleLengths = titles.map(t => t.length).sort((a, b) => a - b);

  const hasQuestion = (t: string) => /\?/.test(t);
  const hasNumber = (t: string) => /\d/.test(t);
  const hasBrackets = (t: string) => /[\[\]\(\)]/.test(t);
  const isAllCapsWord = (t: string) => /\b[A-Z]{4,}\b/.test(t);
  const hasEmoji = (t: string) => /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/u.test(t);

  const pct = (fn: (t: string) => boolean) => titles.filter(fn).length / n;

  // Word frequency
  const wordCounts = new Map<string, number>();
  for (const t of titles) for (const w of tokenizeTitle(t)) wordCounts.set(w, (wordCounts.get(w) || 0) + 1);
  const topWords = Array.from(wordCounts.entries()).sort((a, b) => b[1] - a[1]).slice(0, 15).map(([word, count]) => ({ word, count }));

  // Top vs bottom performer cohorts by view_count
  const sortedByViews = [...vids].sort((a, b) => b.view_count - a.view_count);
  const topCutoff = Math.max(1, Math.ceil(n * 0.1));
  const topPerformers = sortedByViews.slice(0, topCutoff);
  const bottomPerformers = sortedByViews.slice(-topCutoff).reverse();
  const outliers = sortedByViews.filter(v => medianViews > 0 && v.view_count >= medianViews * 3);

  const topWordCounts = new Map<string, number>();
  const botWordCounts = new Map<string, number>();
  for (const v of topPerformers) for (const w of tokenizeTitle(v.title)) topWordCounts.set(w, (topWordCounts.get(w) || 0) + 1);
  for (const v of bottomPerformers) for (const w of tokenizeTitle(v.title)) botWordCounts.set(w, (botWordCounts.get(w) || 0) + 1);

  const topWordsDiff = Array.from(topWordCounts.entries())
    .map(([word, count]) => {
      const topRate = count / topPerformers.length;
      const botRate = (botWordCounts.get(word) || 0) / Math.max(1, bottomPerformers.length);
      const lift = botRate > 0 ? topRate / botRate : topRate * 10;
      return { word, count, topRate, bottomRate: botRate, lift };
    })
    .filter(w => w.count >= 2)
    .sort((a, b) => b.lift - a.lift)
    .slice(0, 10);

  const bottomWords = Array.from(botWordCounts.entries())
    .filter(([word, count]) => count >= 2 && (topWordCounts.get(word) || 0) === 0)
    .map(([word, count]) => ({ word, count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 10);

  // --- tags ---
  const tagCounts = new Map<string, { count: number; views: number }>();
  for (const v of vids) {
    for (const tag of v.tags) {
      const key = tag.toLowerCase();
      const e = tagCounts.get(key) || { count: 0, views: 0 };
      e.count++;
      e.views += v.view_count;
      tagCounts.set(key, e);
    }
  }
  const topTags = Array.from(tagCounts.entries())
    .filter(([, e]) => e.count >= 2)
    .sort((a, b) => b[1].count - a[1].count)
    .slice(0, 15)
    .map(([tag, e]) => ({ tag, count: e.count, avgViews: Math.round(e.views / e.count) }));

  const tagsInTop = new Map<string, number>();
  const tagsInBottom = new Map<string, number>();
  for (const v of topPerformers) for (const tag of v.tags) tagsInTop.set(tag.toLowerCase(), (tagsInTop.get(tag.toLowerCase()) || 0) + 1);
  for (const v of bottomPerformers) for (const tag of v.tags) tagsInBottom.set(tag.toLowerCase(), (tagsInBottom.get(tag.toLowerCase()) || 0) + 1);
  const tagsInTopPerformers = Array.from(tagsInTop.entries()).sort((a, b) => b[1] - a[1]).slice(0, 10).map(([tag, count]) => ({ tag, count }));
  const tagsInBottomPerformers = Array.from(tagsInBottom.entries()).sort((a, b) => b[1] - a[1]).slice(0, 10).map(([tag, count]) => ({ tag, count }));

  const avgTagsPerVideo = mean(vids.map(v => v.tags.length));

  // --- descriptions ---
  const descLengths = vids.map(v => (v.description || '').length).sort((a, b) => a - b);
  const descWithHash = vids.filter(v => countHashtags(v.description || '') > 0).length;
  const descWithLink = vids.filter(v => countLinks(v.description || '') > 0).length;
  const descWithChap = vids.filter(v => hasChapters(v.description || '')).length;
  const avgHashtags = mean(vids.map(v => countHashtags(v.description || '')));

  // --- categories ---
  const catAgg = new Map<string, { count: number; views: number }>();
  for (const v of vids) {
    const label = YT_CATEGORY_MAP[v.category_id || ''] || 'Other';
    const e = catAgg.get(label) || { count: 0, views: 0 };
    e.count++;
    e.views += v.view_count;
    catAgg.set(label, e);
  }
  const categories = Array.from(catAgg.entries())
    .sort((a, b) => b[1].count - a[1].count)
    .map(([label, e]) => ({ label, count: e.count, avgViews: Math.round(e.views / e.count) }));

  // --- trend (rolling 4 oldest→newest) ---
  const rolling: { date: string; avg: number }[] = [];
  const window = 4;
  for (let i = window - 1; i < byDate.length; i++) {
    const slice = byDate.slice(i - window + 1, i + 1);
    rolling.push({
      date: byDate[i].published_at.slice(0, 10),
      avg: Math.round(mean(slice.map(s => s.view_count))),
    });
  }
  const half = Math.floor(byDate.length / 2);
  const firstHalfAvg = mean(byDate.slice(0, half).map(v => v.view_count));
  const secondHalfAvg = mean(byDate.slice(half).map(v => v.view_count));
  const momentumPct = firstHalfAvg > 0 ? ((secondHalfAvg - firstHalfAvg) / firstHalfAvg) * 100 : 0;
  const momentum: 'accelerating' | 'declining' | 'steady' =
    momentumPct > 15 ? 'accelerating' : momentumPct < -15 ? 'declining' : 'steady';

  return {
    dataset: { videoCount: n, oldestPublishedAt: oldest, newestPublishedAt: newest, spanDays },
    performance: {
      medianViews,
      meanViews: Math.round(meanViews),
      p10Views: p10,
      p90Views: p90,
      stddevViews: Math.round(stddev(views)),
      medianEngagementRate: percentile(engagement, 0.5),
      medianLikeRate: percentile(likeRates, 0.5),
      medianCommentRate: percentile(commentRates, 0.5),
    },
    cadence: {
      uploadsPerWeek: Math.round(uploadsPerWeek * 100) / 100,
      medianGapDays: Math.round(medianGap * 10) / 10,
      stddevGapDays: Math.round(gapStd * 10) / 10,
      consistencyScore: Math.round(consistencyScore * 100) / 100,
      dayOfWeekHistogram: dowHist,
      hourOfDayHistogram: hourHist,
      bestDayByAvgViews: bestDay,
      bestHourByAvgViews: bestHour,
    },
    duration: {
      buckets: bucketStats as CompetitorAnalytics['duration']['buckets'],
      bestBucket,
      worstBucket,
    },
    titles: {
      medianLength: percentile(titleLengths, 0.5),
      pctWithQuestion: pct(hasQuestion),
      pctWithNumber: pct(hasNumber),
      pctWithBrackets: pct(hasBrackets),
      pctAllCaps: pct(isAllCapsWord),
      pctWithEmoji: pct(hasEmoji),
      topWordsOverall: topWords,
      topWordsInTopPerformers: topWordsDiff,
      topWordsInBottomPerformers: bottomWords,
    },
    tags: {
      avgTagsPerVideo: Math.round(avgTagsPerVideo * 10) / 10,
      topTags,
      tagsInTopPerformers,
      tagsInBottomPerformers,
    },
    descriptions: {
      medianLength: percentile(descLengths, 0.5),
      pctWithHashtags: descWithHash / n,
      pctWithLinks: descWithLink / n,
      pctWithChapters: descWithChap / n,
      avgHashtagsPerVideo: Math.round(avgHashtags * 10) / 10,
    },
    categories,
    topPerformers,
    bottomPerformers,
    outliers,
    trend: {
      rollingAvgViews: rolling,
      firstHalfAvgViews: Math.round(firstHalfAvg),
      secondHalfAvgViews: Math.round(secondHalfAvg),
      momentum,
      momentumPct: Math.round(momentumPct * 10) / 10,
    },
  };
}
