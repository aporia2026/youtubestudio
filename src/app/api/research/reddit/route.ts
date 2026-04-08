import { NextRequest, NextResponse } from 'next/server';

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

// Use a browser-like UA — Reddit blocks generic bot UAs from cloud IPs
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

/**
 * Fetch top comments for a Reddit post.
 */
async function fetchTopComments(permalink: string, limit = 5): Promise<RedditComment[]> {
  try {
    const url = `https://www.reddit.com${permalink}.json?sort=top&limit=${limit}`;
    const res = await fetch(url, { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(8000) });
    if (!res.ok) return [];
    const data = await res.json();
    // data[1] contains the comments listing
    const commentListing = data?.[1]?.data?.children || [];
    return commentListing
      .filter((c: { kind: string; data: { body?: string; stickied?: boolean } }) =>
        c.kind === 't1' && c.data.body && !c.data.stickied)
      .slice(0, limit)
      .map((c: { data: { body: string; score: number; author: string } }) => ({
        body: decodeHtmlEntities(c.data.body).slice(0, 600),
        score: c.data.score,
        author: c.data.author,
      }));
  } catch {
    return [];
  }
}

/**
 * Scrapes Reddit's public JSON API for trending posts in a niche.
 * Fetches top comments for the most engaging posts.
 * No API key required — uses Reddit's public .json endpoints.
 */
export async function POST(req: NextRequest) {
  try {
    const { niche, subreddits, limit = 25 } = await req.json();

    if (!niche) {
      return NextResponse.json({ error: 'niche is required' }, { status: 400 });
    }

    const results: RedditPost[] = [];

    // 1. Search Reddit globally for the niche — two sort strategies to stay within rate limits
    const searchSorts = ['relevance', 'top'];
    for (const sort of searchSorts) {
      try {
        const searchUrl = `https://www.reddit.com/search.json?q=${encodeURIComponent(niche)}&sort=${sort}&t=month&limit=${Math.ceil(limit / searchSorts.length)}`;
        const searchRes = await fetch(searchUrl, { headers: { 'User-Agent': UA } });
        if (searchRes.status === 429) {
          return NextResponse.json({ error: 'Reddit rate limit — please wait a minute and try again' }, { status: 429 });
        }
        if (searchRes.ok) {
          const text = await searchRes.text();
          // Reddit sometimes returns HTML instead of JSON (bot detection)
          if (!text.startsWith('{') && !text.startsWith('[')) {
            console.error(`Reddit returned non-JSON for search (${sort}):`, text.slice(0, 200));
            continue;
          }
          const data = JSON.parse(text);
          const posts = data?.data?.children || [];
          for (const post of posts) {
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
        } else {
          console.error(`Reddit search (${sort}) returned ${searchRes.status}`);
        }
      } catch (err) {
        console.error(`Reddit search (${sort}) error:`, err);
      }
    }

    // 2. Fetch from specific subreddits if provided — hot + top
    if (subreddits?.length) {
      for (const sub of subreddits.slice(0, 5)) {
        for (const sortType of ['hot', 'top']) {
          try {
            const timeParam = sortType === 'top' ? '&t=month' : '';
            const subUrl = `https://www.reddit.com/r/${encodeURIComponent(sub)}/${sortType}.json?limit=10${timeParam}`;
            const subRes = await fetch(subUrl, { headers: { 'User-Agent': UA } });
            if (subRes.status === 429) continue;
            if (subRes.ok) {
              const data = await subRes.json();
              const posts = data?.data?.children || [];
              for (const post of posts) {
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
            }
          } catch (err) {
            console.error(`Reddit r/${sub} (${sortType}) error:`, err);
          }
        }
      }
    }

    // Sort by engagement (score + comments weighted)
    results.sort((a, b) => (b.score + b.numComments * 2) - (a.score + a.numComments * 2));

    // Deduplicate by title
    const seen = new Set<string>();
    const unique = results.filter(r => {
      const key = r.title.toLowerCase().slice(0, 50);
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });

    // Take top posts and fetch their top comments in parallel
    const topPosts = unique.slice(0, 15);
    const commentFetches = topPosts
      .filter(p => p.numComments > 3)
      .slice(0, 5) // limit to 5 to stay within Reddit rate limits
      .map(async (post) => {
        post.topComments = await fetchTopComments(post.permalink, 5);
      });
    await Promise.allSettled(commentFetches);

    // Build a rich summary for the AI prompt — includes URLs, selftext, and top comments
    const summary = topPosts.map((p, i) => {
      const lines: string[] = [];
      lines.push(`### REDDIT POST ${i + 1}: "${p.title}"`);
      lines.push(`**Subreddit:** r/${p.subreddit} | **Upvotes:** ${p.score.toLocaleString()} | **Comments:** ${p.numComments.toLocaleString()} | **URL:** ${p.url}`);

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

    return NextResponse.json({
      posts: topPosts,
      summary,
      totalFound: unique.length,
    });
  } catch (err: unknown) {
    console.error('Reddit research error:', err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Reddit research failed' },
      { status: 500 },
    );
  }
}
