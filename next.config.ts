import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  experimental: {
    serverActions: {
      bodySizeLimit: '50mb',
    },
  },
  // Tell Next.js not to bundle these Node.js-only packages — require them directly
  // from node_modules at runtime (needed for the server-side Remotion render route)
  serverExternalPackages: [
    '@remotion/renderer',
    '@remotion/bundler',
    '@remotion/cli',
  ],
  images: {
    remotePatterns: [
      { protocol: 'https', hostname: '*.ytimg.com' },
      { protocol: 'https', hostname: '*.youtube.com' },
      { protocol: 'https', hostname: '*.googleusercontent.com' },
      { protocol: 'https', hostname: '*.ggpht.com' },
      { protocol: 'https', hostname: '*.vercel-storage.com' },
      // Kie.ai CDN images (used as Remotion <Img> src during rendering)
      { protocol: 'https', hostname: '*.kie.ai' },
      { protocol: 'https', hostname: 'kie.ai' },
    ],
  },
  // Empty turbopack config silences the "webpack config ignored" warning
  // while still using Turbopack (Next.js 16 default)
  turbopack: {},
};

export default nextConfig;
