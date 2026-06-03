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
    // ffmpeg binary for the FFmpeg-native renderer + pronunciation-review
    // audio slicing. Its index.js does a dynamic require() of the
    // per-platform binary subpackage (@ffmpeg-installer/linux-x64 on
    // Vercel), which Turbopack can't statically resolve at build time —
    // externalizing leaves the require to run via native Node at runtime.
    '@ffmpeg-installer/ffmpeg',
  ],
  // @remotion/bundler (4.0.460) bundles with rspack, whose native binding is
  // loaded via a runtime require of '@rspack/binding' (which in turn requires
  // the per-platform '@rspack/binding-linux-x64-gnu' on Vercel). Next's file
  // tracing can't follow that native require, so the render function shipped
  // WITHOUT the @rspack tree and died with "Cannot find module '@rspack/binding'".
  // Force the whole @rspack tree into the render functions so the linux binary
  // is present at runtime. Keep this in sync with any new in-function render route.
  outputFileTracingIncludes: {
    '/api/render/short': ['./node_modules/@rspack/**/*'],
    '/api/render/video': ['./node_modules/@rspack/**/*'],
  },
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
      // Cloudflare R2 (video review thumbnails)
      { protocol: 'https', hostname: '*.r2.dev' },
    ],
  },
  // Empty turbopack config silences the "webpack config ignored" warning
  // while still using Turbopack (Next.js 16 default)
  turbopack: {},
};

export default nextConfig;
