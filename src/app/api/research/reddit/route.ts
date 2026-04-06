import { NextRequest, NextResponse } from 'next/server';

export const maxDuration = 30;

interface RedditPost {
  title: string;
  score: number;
  numComments: number;
  url: string;
  selftext: string;
  subreddit: string;
  created: number;
}

/**
 * Scrapes Reddit's public JSON API for trending posts in a niche.
 * No API key required — uses Reddit's public .json endpoints.
 */
export async function POST(req: NextRequest) {
  try {
    const { niche, subreddits, limit = 20 } = await req.json();

    if (!niche) {
      return NextResponse.json({ error: 'niche is required' }, { status: 400 });
    }

    // Strategy: search Reddit for the niche, and optionally fetch from specific subreddits
    const results: RedditPost[] = [];

    // 1. Search Reddit globally for the niche
    try {
      const searchUrl = `https://www.reddit.com/search.json?q=${encodeURIComponent(niche)}&sort=relevance&t=month&limit=${limit}`;
      const searchRes = await fetch(searchUrl, {
        headers: { 'User-Agent': 'YTStudio/1.0' },
      });
      if (searchRes.ok) {
        const data = await searchRes.json();
        const posts = data?.data?.children || [];
        for (const post of posts) {
          const d = post.data;
          if (d.over_18) continue;
          results.push({
            title: d.title,
            score: d.score,
            numComments: d.num_comments,
            url: `https://reddit.com${d.permalink}`,
            selftext: (d.selftext || '').slice(0, 500),
            subreddit: d.subreddit,
            created: d.created_utc,
          });
        }
      }
    } catch (err) {
      console.error('Reddit search error:', err);
    }

    // 2. Fetch from specific subreddits if provided
    if (subreddits?.length) {
      for (const sub of subreddits.slice(0, 3)) {
        try {
          const subUrl = `https://www.reddit.com/r/${encodeURIComponent(sub)}/hot.json?limit=10`;
          const subRes = await fetch(subUrl, {
            headers: { 'User-Agent': 'YTStudio/1.0' },
          });
          if (subRes.ok) {
            const data = await subRes.json();
            const posts = data?.data?.children || [];
            for (const post of posts) {
              const d = post.data;
              if (d.over_18 || d.stickied) continue;
              results.push({
                title: d.title,
                score: d.score,
                numComments: d.num_comments,
                url: `https://reddit.com${d.permalink}`,
                selftext: (d.selftext || '').slice(0, 500),
                subreddit: d.subreddit,
                created: d.created_utc,
              });
            }
          }
        } catch (err) {
          console.error(`Reddit r/${sub} error:`, err);
        }
      }
    }

    // Sort by engagement (score + comments)
    results.sort((a, b) => (b.score + b.numComments * 2) - (a.score + a.numComments * 2));

    // Deduplicate by title
    const seen = new Set<string>();
    const unique = results.filter(r => {
      const key = r.title.toLowerCase().slice(0, 50);
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });

    // Build a summary for the AI prompt
    const summary = unique.slice(0, 15).map((p, i) =>
      `${i + 1}. [r/${p.subreddit}] "${p.title}" (${p.score} upvotes, ${p.numComments} comments)${p.selftext ? `\n   ${p.selftext.slice(0, 200)}` : ''}`
    ).join('\n');

    return NextResponse.json({
      posts: unique.slice(0, 20),
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
