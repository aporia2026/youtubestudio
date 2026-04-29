'use client';

import { motion } from 'framer-motion';
import Link from 'next/link';
import { useEffect, useState } from 'react';

interface Stats {
  projects: number;
  scripts: number;
  ideas: number;
  qaRuns: number;
}

const QUICK_ACTIONS = [
  {
    label: 'Generate Script',
    description: 'AI-powered script from topic & length',
    href: '/generator',
    icon: (
      <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
        <path d="M12 2L2 7l10 5 10-5-10-5z" /><path d="M2 17l10 5 10-5" /><path d="M2 12l10 5 10-5" />
      </svg>
    ),
    gradient: 'linear-gradient(135deg, #7c3aed, #06b6d4)',
    glow: 'rgba(124,58,237,0.3)',
  },
  {
    label: 'QA a Script',
    description: 'Brutally critique any script',
    href: '/qa',
    icon: (
      <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
        <circle cx="11" cy="11" r="8" /><path d="m21 21-4.35-4.35" /><path d="M11 8v3l2 2" />
      </svg>
    ),
    gradient: 'linear-gradient(135deg, #ec4899, #f59e0b)',
    glow: 'rgba(236,72,153,0.3)',
  },
  {
    label: 'Find Ideas',
    description: 'Discover high-potential video ideas',
    href: '/ideas',
    icon: (
      <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
        <path d="M9 18h6" /><path d="M10 22h4" />
        <path d="M15.09 14c.18-.98.65-1.74 1.41-2.5A4.65 4.65 0 0 0 18 8 6 6 0 0 0 6 8c0 1 .23 2.23 1.5 3.5A4.61 4.61 0 0 1 8.91 14" />
      </svg>
    ),
    gradient: 'linear-gradient(135deg, #10b981, #06b6d4)',
    glow: 'rgba(16,185,129,0.3)',
  },
  {
    label: 'New Project',
    description: 'Start a full video production',
    href: '/projects/new',
    icon: (
      <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
        <path d="M12 5v14M5 12h14" />
      </svg>
    ),
    gradient: 'linear-gradient(135deg, #f59e0b, #ec4899)',
    glow: 'rgba(245,158,11,0.3)',
  },
];

const FEATURE_CARDS = [
  {
    icon: '🎬',
    title: 'Script Generator',
    desc: 'Generate complete, publish-ready scripts with AI. Pick category, topic, length, tone, and get a full script with visual cues.',
    href: '/generator',
    badge: 'AI-Powered',
  },
  {
    icon: '🔬',
    title: 'Brutal QA Engine',
    desc: 'Submit your script to the harshest AI critic. Multiple passes, category-by-category scoring, with exact rewrite suggestions.',
    href: '/qa',
    badge: 'Multi-Pass',
  },
  {
    icon: '💡',
    title: 'Idea Generator',
    desc: 'Niche-aware AI brainstorms high-potential video ideas with trend analysis, audience targeting, and thumbnail concepts.',
    href: '/ideas',
    badge: 'Trending',
  },
  {
    icon: '🎙️',
    title: 'Voiceover Studio',
    desc: 'Generate voiceovers with ElevenLabs Pro. Browse voices, tune style & stability, preview and approve before saving.',
    href: '/projects',
    badge: 'ElevenLabs',
  },
  {
    icon: '📁',
    title: 'Video Projects',
    desc: 'Organize every video: scripts, voiceovers, media assets, YouTube references — all in one production workspace.',
    href: '/projects',
    badge: 'Full Suite',
  },
  {
    icon: '📡',
    title: 'Channel Integration',
    desc: 'Connect your YouTube channel to analyze performance, identify content gaps, and get data-driven recommendations.',
    href: '/channel',
    badge: 'YouTube API',
  },
  {
    icon: '🔍',
    title: 'SEO Optimizer',
    desc: 'Optimize titles, descriptions, and tags for maximum discoverability with AI-powered keyword analysis.',
    href: '/seo',
    badge: 'SEO',
  },
  {
    icon: '🖼️',
    title: 'Thumbnails',
    desc: 'Design eye-catching thumbnails with text overlays, reference images, and AI-generated concepts.',
    href: '/thumbnails',
    badge: 'Visual',
  },
  {
    icon: '📊',
    title: 'Competitors',
    desc: 'Track and analyze competitor channels to find content gaps and winning strategies in your niche.',
    href: '/competitors',
    badge: 'Analytics',
  },
];

const containerVariants = {
  hidden: {},
  show: { transition: { staggerChildren: 0.07 } },
};

const itemVariants = {
  hidden: { opacity: 0, y: 20 },
  show: { opacity: 1, y: 0, transition: { duration: 0.4 } },
};

export default function DashboardPage() {
  const [stats, setStats] = useState<Stats>({ projects: 0, scripts: 0, ideas: 0, qaRuns: 0 });
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetch('/api/stats')
      .then(r => r.json())
      .then(data => setStats(data))
      .catch(() => {})
      .finally(() => setLoading(false));
  }, []);

  return (
    <div className="p-8 max-w-6xl mx-auto">
      {/* Hero */}
      <motion.div
        initial={{ opacity: 0, y: -20 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.5 }}
        className="mb-10"
      >
        <div className="flex items-center gap-3 mb-2">
          <div className="w-10 h-10 rounded-xl flex items-center justify-center pulse-glow"
            style={{ background: 'linear-gradient(135deg, #7c3aed, #06b6d4)' }}>
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none">
              <path d="M8 5v14l11-7L8 5z" fill="white" />
            </svg>
          </div>
          <span className="badge badge-purple">AI Content Engine</span>
        </div>
        <h1 className="text-4xl font-bold mb-2">
          <span className="gradient-text">YouTube Studio</span>
        </h1>
        <p className="text-lg" style={{ color: 'var(--text-secondary)' }}>
          Your end-to-end AI-powered content creation workspace.
        </p>
      </motion.div>

      {/* Stats Row */}
      <motion.div
        variants={containerVariants}
        initial="hidden"
        animate="show"
        className="grid grid-cols-2 md:grid-cols-4 gap-4 mb-10"
      >
        {[
          { label: 'Projects', value: stats.projects, icon: '📁', color: 'var(--accent-purple-bright)', href: '/projects' },
          { label: 'Scripts', value: stats.scripts, icon: '📝', color: 'var(--accent-cyan-bright)', href: '/generator' },
          { label: 'Ideas Saved', value: stats.ideas, icon: '💡', color: 'var(--accent-green)', href: '/ideas' },
          { label: 'QA Runs', value: stats.qaRuns, icon: '🔬', color: 'var(--accent-pink)', href: '/qa' },
        ].map(stat => (
          <motion.div key={stat.label} variants={itemVariants} whileHover={{ y: -3 }}>
            <Link href={stat.href}>
              <div
                className="glass rounded-xl p-5 cursor-pointer transition-all"
                style={{ border: '1px solid var(--border)' }}
                onMouseEnter={e => (e.currentTarget as HTMLDivElement).style.borderColor = 'var(--border-bright)'}
                onMouseLeave={e => (e.currentTarget as HTMLDivElement).style.borderColor = 'var(--border)'}
              >
                <div className="text-2xl mb-2">{stat.icon}</div>
                <div className="text-2xl font-bold" style={{ color: stat.color }}>
                  {loading ? '—' : stat.value}
                </div>
                <div className="text-sm" style={{ color: 'var(--text-muted)' }}>{stat.label}</div>
              </div>
            </Link>
          </motion.div>
        ))}
      </motion.div>

      {/* Quick Actions */}
      <motion.div
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        transition={{ delay: 0.2 }}
        className="mb-10"
      >
        <h2 className="text-sm font-semibold uppercase tracking-wider mb-4" style={{ color: 'var(--text-muted)' }}>
          Quick Actions
        </h2>
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
          {QUICK_ACTIONS.map((action, i) => (
            <motion.div
              key={action.href}
              initial={{ opacity: 0, scale: 0.95 }}
              animate={{ opacity: 1, scale: 1 }}
              transition={{ delay: 0.1 + i * 0.05 }}
              whileHover={{ y: -4 }}
            >
              <Link href={action.href}>
                <div
                  className="p-5 rounded-xl cursor-pointer transition-all"
                  style={{
                    background: 'var(--bg-card)',
                    border: '1px solid var(--border)',
                  }}
                  onMouseEnter={e => {
                    (e.currentTarget as HTMLDivElement).style.border = '1px solid rgba(124,58,237,0.4)';
                    (e.currentTarget as HTMLDivElement).style.boxShadow = `0 8px 30px ${action.glow}`;
                  }}
                  onMouseLeave={e => {
                    (e.currentTarget as HTMLDivElement).style.border = '1px solid var(--border)';
                    (e.currentTarget as HTMLDivElement).style.boxShadow = 'none';
                  }}
                >
                  <div className="w-10 h-10 rounded-lg flex items-center justify-center mb-3"
                    style={{ background: action.gradient }}>
                    <span style={{ color: 'white' }}>{action.icon}</span>
                  </div>
                  <div className="font-semibold text-sm mb-1" style={{ color: 'var(--text-primary)' }}>
                    {action.label}
                  </div>
                  <div className="text-xs" style={{ color: 'var(--text-muted)' }}>
                    {action.description}
                  </div>
                </div>
              </Link>
            </motion.div>
          ))}
        </div>
      </motion.div>

      {/* Feature Cards */}
      <motion.div
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        transition={{ delay: 0.3 }}
      >
        <h2 className="text-sm font-semibold uppercase tracking-wider mb-4" style={{ color: 'var(--text-muted)' }}>
          All Features
        </h2>
        <motion.div
          variants={containerVariants}
          initial="hidden"
          animate="show"
          className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4"
        >
          {FEATURE_CARDS.map(card => (
            <motion.div key={card.title} variants={itemVariants} whileHover={{ y: -3 }}>
              <Link href={card.href}>
                <div className="glass rounded-xl p-6 h-full cursor-pointer group transition-all"
                  style={{ border: '1px solid var(--border)' }}
                  onMouseEnter={e => (e.currentTarget as HTMLDivElement).style.borderColor = 'var(--border-bright)'}
                  onMouseLeave={e => (e.currentTarget as HTMLDivElement).style.borderColor = 'var(--border)'}
                >
                  <div className="flex items-start justify-between mb-3">
                    <span className="text-2xl">{card.icon}</span>
                    <span className="badge badge-purple text-xs">{card.badge}</span>
                  </div>
                  <h3 className="font-semibold mb-2" style={{ color: 'var(--text-primary)' }}>{card.title}</h3>
                  <p className="text-sm leading-relaxed" style={{ color: 'var(--text-secondary)' }}>{card.desc}</p>
                  <div className="mt-4 flex items-center gap-1 text-xs font-medium" style={{ color: 'var(--accent-purple-bright)' }}>
                    Open
                    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                      <path d="M5 12h14M12 5l7 7-7 7" />
                    </svg>
                  </div>
                </div>
              </Link>
            </motion.div>
          ))}
        </motion.div>
      </motion.div>
    </div>
  );
}
