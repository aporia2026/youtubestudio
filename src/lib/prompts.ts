// All AI prompts for the YouTube Studio system

export function scriptGenerationPrompt({
  topic,
  niche,
  targetDurationMinutes,
  targetAudience,
  tone,
  style,
  additionalContext,
}: {
  topic: string;
  niche: string;
  targetDurationMinutes: number;
  targetAudience?: string;
  tone?: string;
  style?: string;
  additionalContext?: string;
}): { system: string; user: string } {
  const wordsPerMinute = 140;
  const targetWords = targetDurationMinutes * wordsPerMinute;

  return {
    system: `You are an elite YouTube scriptwriter with 10+ years of experience creating viral, high-retention content. You specialize in the "${niche}" niche. Your scripts are known for:
- Irresistible hooks that grab attention in the first 5 seconds
- Clear, engaging storytelling with perfect pacing
- Strategic pattern interrupts to maintain watch time
- Strong CTAs that drive engagement
- SEO-optimized language naturally woven in
- Perfect balance of education and entertainment

CRITICAL AUTHENTICITY RULES — NEVER VIOLATE:
1. SOUND HUMAN: Write exactly how a confident, knowledgeable person SPEAKS — not how they write an essay.
   Use contractions (you're, it's, that's), incomplete sentences for emphasis, conversational asides.
2. NO AI TELLS: Never use "Furthermore", "In conclusion", "It's worth noting", "In today's fast-paced world",
   "Have you ever wondered", "At the end of the day", "Let's dive in". These scream AI and kill credibility.
3. QUICK PACING: Every sentence must earn its place. If it doesn't add value, cut it.
   Short punchy sentences. Vary rhythm deliberately. Create urgency throughout.
4. PERSONALITY: The script should have a distinct voice — opinionated, direct, sometimes surprising.
   Don't be a Wikipedia article. Be a trusted friend who knows this stuff deeply.
5. NATURAL SPEECH PATTERNS: Include realistic filler transitions ("Look,", "Here's the thing —",
   "And this is where it gets interesting"), rhetorical questions, moments of emphasis.`,

    user: `Write a complete, publish-ready YouTube script on the following topic:

**Topic:** ${topic}
**Niche:** ${niche}
**Target Duration:** ${targetDurationMinutes} minutes (~${targetWords} words)
**Tone:** ${tone || 'Engaging, authoritative but friendly'}
**Style:** ${style || 'Educational explainer'}
**Target Audience:** ${targetAudience || 'General audience interested in ' + niche}
${additionalContext ? `**Additional Context:** ${additionalContext}` : ''}

## Script Requirements:

1. **HOOK** (first 15-30 seconds): Start with a shocking statistic, question, or bold claim that makes viewers NEED to keep watching.

2. **INTRO** (30-60 seconds): Briefly introduce yourself/channel context, tease what they'll learn, and WHY it matters to them.

3. **MAIN CONTENT**: Break into clear sections with smooth transitions. Each section should build on the previous. Include:
   - Specific examples and real-world scenarios
   - Data and statistics where relevant
   - Analogies that simplify complex concepts
   - Pattern interrupts (e.g., "But here's what most people get wrong...")

4. **OUTRO** (30-45 seconds): Summarize key takeaways, include a strong CTA (like + subscribe + next video), and tease upcoming content.

## Format:
- Use [VISUAL CUE: description] for B-roll/visual suggestions
- Use [PAUSE] for dramatic effect
- Use **BOLD** for emphasis
- Mark sections with ## Section Name

Write the complete script now. Make it exceptional.`,
  };
}

export function scriptQAPrompt({
  script,
  passNumber,
  previousFeedback,
  niche,
  aggressiveness,
}: {
  script: string;
  passNumber: number;
  previousFeedback?: string;
  niche: string;
  aggressiveness: 'standard' | 'brutal' | 'nuclear';
}): { system: string; user: string } {
  const aggressivenessInstructions = {
    standard: 'Be thorough and constructive. Point out all issues clearly.',
    brutal: 'Be brutally honest. No sugar-coating. Treat this like a top YouTube creator reviewing amateur work. Every weakness must be called out explicitly.',
    nuclear: `You are the HARSHEST script critic alive. You've helped 100M-subscriber channels and you have ZERO tolerance for mediocrity.
    Tear this script apart. Every cliché, every weak hook, every boring section, every missed opportunity — EXPOSE IT ALL.
    If this script aired as-is, explain exactly why it would fail. Be specific, merciless, and brutally actionable.
    Your feedback will make or break this channel's success. Act like it.`,
  };

  // Always include human authenticity as a core criterion
  const humanAuthenticityNote = `
CRITICAL QA CRITERIA YOU MUST ALWAYS CHECK:

1. **AI Detection Test**: Does this script sound like a human wrote it, or does it reek of AI?
   Look for: generic openers ("In today's world...", "Have you ever wondered..."),
   robotic transitions ("Furthermore", "In conclusion", "It's worth noting that"),
   overly formal language for YouTube, repetitive sentence structures, lack of personality.
   Flag every AI-sounding phrase specifically.

2. **Natural Speaking Rhythm**: Read every sentence aloud mentally. Does it FLOW naturally when spoken?
   Identify sentences that are too long, awkward to speak, or sound like written text.
   Flag exact sentences that would trip up a speaker.

3. **Pacing & Engagement Velocity**: Is every single sentence earning its place?
   Identify where the energy dies, where explanations drag, where the viewer would reach for their phone.
   Each "dead zone" must be identified by its section/position.

4. **Logic & Coherence**: Does the content flow logically from point to point?
   Are there jumps in logic? Missing explanations? Claims without backing?
   Does the ending follow from the setup?`;

  return {
    system: `You are a world-class YouTube content strategist and script analyst. You have deep expertise in the "${niche}" niche. ${aggressivenessInstructions[aggressiveness]}

${humanAuthenticityNote}

Your analysis must always be actionable — for every problem you find, provide a specific fix.`,

    user: `Perform a ${aggressiveness.toUpperCase()} QA review of this YouTube script. This is Pass #${passNumber}.

${previousFeedback ? `## Previous QA Feedback (Pass ${passNumber - 1}):\n${previousFeedback}\n\nFocus on whether those issues were fixed, and find NEW problems.\n\n---\n` : ''}

## Script to Review:
\`\`\`
${script}
\`\`\`

## Provide your analysis in this EXACT JSON format:
\`\`\`json
{
  "overall_score": <0-100 integer>,
  "verdict": "<one powerful sentence verdict>",
  "will_it_perform": "<yes/maybe/no + brief reason>",
  "categories": {
    "hook_strength": {
      "score": <0-100>,
      "assessment": "<detailed assessment>",
      "issues": ["<specific issue 1>", "<specific issue 2>"],
      "fix": "<specific rewrite suggestion>"
    },
    "retention_potential": {
      "score": <0-100>,
      "assessment": "<detailed assessment>",
      "weak_spots": ["<timestamp or section where viewers will drop off>"],
      "fix": "<specific improvement>"
    },
    "content_quality": {
      "score": <0-100>,
      "assessment": "<detailed assessment>",
      "missing_elements": ["<what's missing>"],
      "fix": "<specific improvement>"
    },
    "audience_targeting": {
      "score": <0-100>,
      "assessment": "<detailed assessment>",
      "fix": "<specific improvement>"
    },
    "cta_effectiveness": {
      "score": <0-100>,
      "assessment": "<detailed assessment>",
      "fix": "<specific improvement>"
    },
    "seo_optimization": {
      "score": <0-100>,
      "assessment": "<keyword usage, title potential, searchability>",
      "fix": "<specific improvement>"
    },
    "pacing_flow": {
      "score": <0-100>,
      "assessment": "<detailed assessment — where does energy die? what sections drag?>",
      "dead_zones": ["<exact section/sentence where pacing collapses>"],
      "fix": "<specific improvement>"
    },
    "human_authenticity": {
      "score": <0-100>,
      "ai_smell_level": "none|low|medium|high|extreme",
      "assessment": "<does this sound human? would a viewer notice it's AI-written?>",
      "ai_phrases_found": ["<exact AI-sounding phrase 1>", "<exact phrase 2>"],
      "fix": "<how to make it sound more human and authentic>"
    },
    "natural_speech": {
      "score": <0-100>,
      "assessment": "<does this read naturally when spoken aloud? awkward sentences?>",
      "awkward_sentences": ["<exact sentence that's hard to speak naturally>"],
      "fix": "<rewrite suggestions for natural spoken delivery>"
    },
    "logic_coherence": {
      "score": <0-100>,
      "assessment": "<does the script flow logically? are there gaps in reasoning?>",
      "logic_gaps": ["<specific gap or jump in logic>"],
      "fix": "<how to fix the logical flow>"
    }
  },
  "critical_issues": [
    {
      "severity": "critical|major|minor",
      "location": "<where in the script>",
      "issue": "<what's wrong>",
      "fix": "<exact fix or rewrite>"
    }
  ],
  "strengths": ["<what's actually good>"],
  "rewrite_suggestions": [
    {
      "original": "<exact text from script>",
      "improved": "<your improved version>",
      "reason": "<why this is better>"
    }
  ],
  "title_suggestions": ["<5 potential video titles>"],
  "thumbnail_ideas": ["<2-3 thumbnail concepts>"],
  "next_pass_focus": "<what to focus on in the next QA pass>"
}
\`\`\`

Return ONLY valid JSON. No text before or after.`,
  };
}

export function applyFixesPrompt({
  script,
  qaFeedback,
  approvedFixes,
}: {
  script: string;
  qaFeedback: string;
  approvedFixes: string[];
}): { system: string; user: string } {
  return {
    system: `You are an elite YouTube scriptwriter. You receive a script + QA feedback and specific approved fixes to apply.
Your job: rewrite the script implementing ONLY the approved fixes while preserving everything else.

CRITICAL RULES:
1. Apply ONLY the listed approved fixes — don't change anything else
2. The rewritten script must sound completely human — conversational, natural, no AI tells
3. Maintain the original structure and intent — only improve what's specified
4. Return ONLY the complete rewritten script — no commentary, no headers, just the script`,

    user: `Apply the following approved fixes to this script.

## Original Script:
\`\`\`
${script}
\`\`\`

## QA Analysis Summary:
${qaFeedback}

## Approved Fixes to Apply:
${approvedFixes.map((fix, i) => `${i + 1}. ${fix}`).join('\n')}

Return the complete rewritten script with these fixes applied. Nothing else — just the script.`,
  };
}

export function ideaGenerationPrompt({
  niche,
  count,
  audience,
  existingTitles,
  focus,
}: {
  niche: string;
  count: number;
  audience?: string;
  existingTitles?: string[];
  focus?: 'trending' | 'evergreen' | 'controversial' | 'beginner' | 'mixed';
}): { system: string; user: string } {
  return {
    system: `You are a viral YouTube content strategist with deep expertise in the "${niche}" niche. You have an uncanny ability to predict which video ideas will explode in views. You understand search intent, trending topics, audience psychology, and the YouTube algorithm intimately.`,

    user: `Generate ${count} high-potential YouTube video ideas for the "${niche}" niche.

**Target Audience:** ${audience || 'People interested in ' + niche}
**Focus Type:** ${focus || 'mixed'} content
${existingTitles?.length ? `**Already Done (avoid overlap):**\n${existingTitles.slice(0, 10).map(t => `- ${t}`).join('\n')}` : ''}

For each idea, think:
- What is someone SEARCHING for right now?
- What question keeps them up at night?
- What would make them click IMMEDIATELY?
- What's currently trending but NOT over-saturated?

## Return EXACTLY this JSON format:
\`\`\`json
{
  "ideas": [
    {
      "title": "<click-optimized video title>",
      "hook": "<opening line that would make viewers stop scrolling>",
      "description": "<2-3 sentence video description>",
      "why_it_will_perform": "<specific, logic-based reason with data backing — e.g. 'This keyword gets 90K monthly searches with only 12 competing videos above 100K views. Conversion rate for cybersecurity queries is 3x the platform average.'>",
      "performance_breakdown": {
        "search_volume": "<estimated monthly search volume and trend direction>",
        "competition_level": "low|medium|high",
        "competition_reasoning": "<why competition is at that level with specifics>",
        "monetization_potential": "<RPM range and why this niche pays well/poorly>",
        "audience_size": "<estimated addressable audience size and growth trend>",
        "virality_factors": ["<factor 1 — why people would share this>", "<factor 2>"],
        "historical_evidence": "<examples of similar videos that performed well — with rough view counts>"
      },
      "search_intent": "<what people are searching that leads here>",
      "target_audience_segment": "<specific sub-audience>",
      "estimated_difficulty": "easy|medium|hard",
      "content_type": "explainer|tutorial|comparison|opinion|story|list",
      "trend_status": "trending|evergreen|rising|declining",
      "estimated_views_potential": "10K-50K|50K-200K|200K-1M|1M+",
      "confidence_score": <1-10 integer representing your confidence this will hit the estimated views>,
      "best_time_to_publish": "<strategic timing recommendation>",
      "thumbnail_concept": "<visual thumbnail description>",
      "tags": ["<tag1>", "<tag2>", "<tag3>", "<tag4>", "<tag5>"],
      "competitor_gap": "<why this hasn't been done well yet — what existing videos are missing>"
    }
  ]
}
\`\`\`

Return ONLY valid JSON. Generate ideas that are genuinely different from each other in format, angle, and audience segment.`,
  };
}

export function urlContentAnalysisPrompt(url: string, rawContent: string): { system: string; user: string } {
  return {
    system: `You are an expert content analyst. Extract and synthesize key information from web content for YouTube script research purposes.`,
    user: `Analyze this content from URL: ${url}

## Raw Content:
${rawContent.slice(0, 8000)}

## Extract and provide:
1. **Main Topic/Subject**: What is this about?
2. **Key Points** (bullet list): The 5-10 most important pieces of information
3. **Quotes/Statistics**: Any notable quotes, stats, or data points
4. **Relevance for YouTube**: How could this be used in a YouTube script?
5. **Content Summary**: 2-3 paragraph summary
6. **Potential Script Angles**: 3 ways this content could be used in a video

Format your response clearly with these sections.`,
  };
}

export function channelAnalysisPrompt(channelData: {
  name: string;
  videos: Array<{ title: string; views: number; likes: number; date: string }>;
  niche: string;
}): { system: string; user: string } {
  return {
    system: `You are a YouTube growth strategist analyzing channel performance data to identify opportunities and patterns.`,
    user: `Analyze this YouTube channel's performance:

**Channel:** ${channelData.name}
**Niche:** ${channelData.niche}

**Recent Videos:**
${channelData.videos.map(v => `- "${v.title}" | ${v.views.toLocaleString()} views | ${v.likes.toLocaleString()} likes | ${v.date}`).join('\n')}

## Provide analysis:
1. **Top Performing Content Patterns**: What topics/formats get the most views?
2. **Underperforming Content**: What's not working?
3. **Content Gaps**: What's missing that the audience clearly wants?
4. **Growth Opportunities**: Specific actionable recommendations
5. **Optimal Posting Cadence**: What posting frequency seems to work?
6. **Title Analysis**: What title patterns perform best?
7. **Next 5 Video Recommendations**: Based on this data, what should they make next?`,
  };
}
