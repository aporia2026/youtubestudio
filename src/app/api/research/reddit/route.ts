import { NextRequest, NextResponse } from 'next/server';
import { logger } from '@/lib/logger';
import { domainErrorResponse } from '@/lib/route-helpers';

export const maxDuration = 60;

interface RedditComment {
  body: string;
  score: number;
  author: string;
}

interface RedditPost {
  title: string;
  score: number;
  numComments: number;
  url: string;
  permalink: string;
  selftext: string;
  subreddit: string;
  created: number;
  topComments: RedditComment[];
}

function decodeHtmlEntities(text: string): string {
  return text
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#x27;/g, "'")
    .replace(/&#x2F;/g, '/');
}

// --- OAuth token cache (in-memory, server-side) ---
let tokenCache: { token: string; expiresAt: number } | null = null;

async function getRedditAccessToken(): Promise<string | null> {
  const clientId = process.env.REDDIT_CLIENT_ID;
  const clientSecret = process.env.REDDIT_CLIENT_SECRET;
  if (!clientId || !clientSecret) return null;

  // Return cached token if still valid
  if (tokenCache && Date.now() < tokenCache.expiresAt) {
    return tokenCache.token;
  }

  try {
    const credentials = Buffer.from(`${clientId}:${clientSecret}`).toString('base64');
    const res = await fetch('https://www.reddit.com/api/v1/access_token', {
      method: 'POST',
      headers: {
        'Authorization': `Basic ${credentials}`,
        'Content-Type': 'application/x-www-form-urlencoded',
        'User-Agent': 'YouTubeStudio/1.0',
      },
      body: 'grant_type=client_credentials',
      signal: AbortSignal.timeout(10000),
    });

    if (!res.ok) {
      logger.error('Reddit OAuth token request failed', { detail: `status ${res.status}` });
      return null;
    }

    const data = await res.json();
    if (!data.access_token) return null;

    tokenCache = {
      token: data.access_token,
      expiresAt: Date.now() + (data.expires_in - 300) * 1000, // refresh 5 min early
    };
    return tokenCache.token;
  } catch (err) {
    logger.error('Reddit OAuth error', { detail: err instanceof Error ? err.message : String(err) });
    return null;
  }
}

// --- Results cache (avoid repeat requests) ---
const resultsCache = new Map<string, { data: { posts: RedditPost[]; summary: string; totalFound: number }; expiresAt: number }>();
const CACHE_TTL = 10 * 60 * 1000; // 10 minutes

// --- OAuth-authenticated fetch from oauth.reddit.com ---
async function fetchViaOAuth(niche: string, subreddits: string[], limit: number, token: string): Promise<RedditPost[]> {
  const results: RedditPost[] = [];
  const headers = {
    'Authorization': `Bearer ${token}`,
    'User-Agent': 'YouTubeStudio/1.0',
  };

  // 1. Global search — two sort strategies
  for (const sort of ['relevance', 'top'] as const) {
    try {
      const searchUrl = `https://oauth.reddit.com/search?q=${encodeURIComponent(niche)}&sort=${sort}&t=month&limit=${Math.ceil(limit / 2)}`;
      const res = await fetch(searchUrl, { headers, signal: AbortSignal.timeout(10000) });
      if (!res.ok) {
        logger.error(`OAuth search (${sort}) returned ${res.status}`);
        continue;
      }
      const data = await res.json();
      for (const post of data?.data?.children || []) {
        const d = post.data;
        if (d.over_18) continue;
        results.push({
          title: decodeHtmlEntities(d.title),
          score: d.score,
          numComments: d.num_comments,
          url: `https://reddit.com${d.permalink}`,
          permalink: d.permalink,
          selftext: decodeHtmlEntities(d.selftext || '').slice(0, 1500),
          subreddit: d.subreddit,
          created: d.created_utc,
          topComments: [],
        });
      }
    } catch (err) {
      logger.error(`OAuth search (${sort}) error:`, { detail: err instanceof Error ? err.message : String(err) });
    }
  }

  // 2. Fetch specific subreddits
  if (subreddits?.length) {
    for (const sub of subreddits.slice(0, 5)) {
      for (const sortType of ['hot', 'top'] as const) {
        try {
          const timeParam = sortType === 'top' ? '&t=month' : '';
          const subUrl = `https://oauth.reddit.com/r/${encodeURIComponent(sub)}/${sortType}?limit=10${timeParam}`;
          const res = await fetch(subUrl, { headers, signal: AbortSignal.timeout(8000) });
          if (!res.ok) continue;
          const data = await res.json();
          for (const post of data?.data?.children || []) {
            const d = post.data;
            if (d.over_18 || d.stickied) continue;
            results.push({
              title: decodeHtmlEntities(d.title),
              score: d.score,
              numComments: d.num_comments,
              url: `https://reddit.com${d.permalink}`,
              permalink: d.permalink,
              selftext: decodeHtmlEntities(d.selftext || '').slice(0, 1500),
              subreddit: d.subreddit,
              created: d.created_utc,
              topComments: [],
            });
          }
        } catch (err) {
          logger.error(`OAuth r/${sub} (${sortType}) error:`, { detail: err instanceof Error ? err.message : String(err) });
        }
      }
    }
  }

  // 3. Fetch top comments for the best posts
  results.sort((a, b) => (b.score + b.numComments * 2) - (a.score + a.numComments * 2));
  const topForComments = results.filter(p => p.numComments > 3).slice(0, 5);
  await Promise.allSettled(
    topForComments.map(async (post) => {
      try {
        const url = `https://oauth.reddit.com${post.permalink}?sort=top&limit=5`;
        const res = await fetch(url, { headers, signal: AbortSignal.timeout(8000) });
        if (!res.ok) return;
        const data = await res.json();
        const commentListing = data?.[1]?.data?.children || [];
        post.topComments = commentListing
          .filter((c: { kind: string; data: { body?: string; stickied?: boolean } }) =>
            c.kind === 't1' && c.data.body && !c.data.stickied)
          .slice(0, 5)
          .map((c: { data: { body: string; score: number; author: string } }) => ({
            body: decodeHtmlEntities(c.data.body).slice(0, 600),
            score: c.data.score,
            author: c.data.author,
          }));
      } catch { /* skip comment fetch failures */ }
    }),
  );

  return results;
}

// --- RSS fallback: no auth needed, works from cloud IPs ---
async function fetchViaRSS(niche: string, subreddits: string[], limit: number): Promise<RedditPost[]> {
  const results: RedditPost[] = [];
  const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

  function parseRSSEntries(xml: string): RedditPost[] {
    const posts: RedditPost[] = [];
    // Match each <entry>...</entry> block
    const entryRegex = /<entry>([\s\S]*?)<\/entry>/g;
    let match;
    while ((match = entryRegex.exec(xml)) !== null) {
      const entry = match[1];

      const titleMatch = entry.match(/<title[^>]*>([\s\S]*?)<\/title>/);
      const linkMatch = entry.match(/<link\s+href="([^"]+)"/);
      const contentMatch = entry.match(/<content[^>]*>([\s\S]*?)<\/content>/);
      const updatedMatch = entry.match(/<updated>([\s\S]*?)<\/updated>/);
      const categoryMatch = entry.match(/<category[^>]*term="([^"]+)"/);

      if (!titleMatch) continue;

      const title = decodeHtmlEntities(titleMatch[1].trim());
      const url = linkMatch ? linkMatch[1] : '';
      const permalink = url.replace('https://www.reddit.com', '').replace('https://reddit.com', '');
      const subreddit = categoryMatch ? categoryMatch[1] : '';

      // Extract text from HTML content
      let selftext = '';
      if (contentMatch) {
        selftext = decodeHtmlEntities(contentMatch[1])
          .replace(/<[^>]+>/g, ' ')  // strip HTML tags
          .replace(/\s+/g, ' ')
          .trim()
          .slice(0, 1500);
      }

      const created = updatedMatch ? Math.floor(new Date(updatedMatch[1]).getTime() / 1000) : 0;

      posts.push({
        title,
        score: 0, // RSS doesn't include scores
        numComments: 0, // RSS doesn't include comment counts
        url: url || `https://reddit.com${permalink}`,
        permalink,
        selftext,
        subreddit,
        created,
        topComments: [],
      });
    }
    return posts;
  }

  // 1. Global search via RSS
  try {
    const searchUrl = `https://www.reddit.com/search.rss?q=${encodeURIComponent(niche)}&sort=top&t=month&limit=${limit}`;
    const res = await fetch(searchUrl, { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(10000) });
    if (res.ok) {
      const xml = await res.text();
      if (xml.includes('<feed') || xml.includes('<entry')) {
        results.push(...parseRSSEntries(xml));
      } else {
        logger.error('Reddit RSS search returned non-feed response');
      }
    }
  } catch (err) {
    logger.error('Reddit RSS search error', { detail: err instanceof Error ? err.message : String(err) });
  }

  // 2. Subreddit RSS feeds
  if (subreddits?.length) {
    const subFetches = subreddits.slice(0, 5).map(async (sub) => {
      try {
        const subUrl = `https://www.reddit.com/r/${encodeURIComponent(sub)}/top/.rss?limit=10&t=month`;
        const res = await fetch(subUrl, { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(8000) });
        if (res.ok) {
          const xml = await res.text();
          if (xml.includes('<feed') || xml.includes('<entry')) {
            results.push(...parseRSSEntries(xml));
          }
        }
      } catch (err) {
        logger.error(`Reddit RSS r/${sub} error:`, { detail: err instanceof Error ? err.message : String(err) });
      }
    });
    await Promise.allSettled(subFetches);
  }

  return results;
}

/**
 * Scrapes Reddit for trending posts in a niche.
 *
 * Strategy:
 * 1. If REDDIT_CLIENT_ID + REDDIT_CLIENT_SECRET are set → OAuth API (oauth.reddit.com, 100 QPM)
 * 2. Otherwise → RSS feeds (no auth, no scores/comments, but works from cloud IPs)
 * 3. Results are cached for 10 minutes to minimize API calls.
 */
export async function POST(req: NextRequest) {
  try {
    const { niche, subreddits, limit = 25 } = await req.json();

    if (!niche) {
      return NextResponse.json({ error: 'niche is required' }, { status: 400 });
    }

    // Check cache first
    const cacheKey = `${niche}:${(subreddits || []).join(',')}:${limit}`;
    const cached = resultsCache.get(cacheKey);
    if (cached && Date.now() < cached.expiresAt) {
      return NextResponse.json({ ...cached.data, cached: true });
    }

    let results: RedditPost[];
    let method: 'oauth' | 'rss';

    // Try OAuth first, fall back to RSS
    const token = await getRedditAccessToken();
    if (token) {
      method = 'oauth';
      results = await fetchViaOAuth(niche, subreddits || [], limit, token);

      // If OAuth returned nothing (possibly blocked), fall back to RSS
      if (results.length === 0) {
        console.warn('OAuth returned no results, falling back to RSS');
        method = 'rss';
        results = await fetchViaRSS(niche, subreddits || [], limit);
      }
    } else {
      method = 'rss';
      results = await fetchViaRSS(niche, subreddits || [], limit);
    }

    // Sort by engagement (RSS posts will have 0 scores, sorted by order)
    results.sort((a, b) => (b.score + b.numComments * 2) - (a.score + a.numComments * 2));

    // Deduplicate by title
    const seen = new Set<string>();
    const unique = results.filter(r => {
      const key = r.title.toLowerCase().slice(0, 50);
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });

    const topPosts = unique.slice(0, 15);

    // Build summary for AI prompt
    const summary = topPosts.map((p, i) => {
      const lines: string[] = [];
      lines.push(`### REDDIT POST ${i + 1}: "${p.title}"`);

      const metaParts = [`**Subreddit:** r/${p.subreddit}`];
      if (p.score > 0) metaParts.push(`**Upvotes:** ${p.score.toLocaleString()}`);
      if (p.numComments > 0) metaParts.push(`**Comments:** ${p.numComments.toLocaleString()}`);
      metaParts.push(`**URL:** ${p.url}`);
      lines.push(metaParts.join(' | '));

      if (p.selftext) {
        lines.push(`**Post content:** ${p.selftext.slice(0, 800)}`);
      }

      if (p.topComments.length > 0) {
        lines.push(`**Top comments (real user opinions & pain points):**`);
        for (const c of p.topComments) {
          lines.push(`  - [${c.score} upvotes] "${c.body.slice(0, 300)}"`);
        }
      }

      return lines.join('\n');
    }).join('\n\n---\n\n');

    const response = {
      posts: topPosts,
      summary,
      totalFound: unique.length,
      method,
    };

    // Cache the results
    resultsCache.set(cacheKey, { data: response, expiresAt: Date.now() + CACHE_TTL });

    return NextResponse.json(response);
  } catch (err) {
    return domainErrorResponse(err, {
      op: 'research: reddit',
      fallbackMessage: 'Reddit research failed — please try again.',
    });
  }
}
