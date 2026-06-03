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
  // The render routes bundle the Remotion composition IN-FUNCTION at request
  // time (`bundle()` -> rspack). That bundler reads files from disk that Next's
  // static tracer never sees, because the composition is loaded via a runtime
  // path string, not a static import. So everything the bundle compiles must be
  // force-included into the function:
  //   - @rspack/**            — the bundler's native binding (rspack -> @rspack/binding -> linux-x64 binary)
  //   - remotion + @remotion  — the framework packages the composition imports
  //   - src/remotion/**       — the composition source (Root.tsx + compositions + components)
  //   - src/lib/**            — the `@/lib/*` modules the composition pulls (and their closure)
  // Without these the bundle fails with "Cannot find module '@rspack/binding'"
  // then "Can't resolve 'remotion'", etc. Keep in sync with any new render route.
  // NB: only the packages the composition actually bundles are listed — NOT
  // all of @remotion/*. @remotion/google-fonts alone is 65MB and the renderer
  // / lambda / studio packages carry big binaries; pulling the whole scope
  // would risk Vercel's 250MB function limit. @remotion/renderer is already a
  // serverExternalPackage, so its files come in separately.
  outputFileTracingIncludes: {
    '/api/render/short': [
      './node_modules/@rspack/**/*',
      './node_modules/remotion/**/*',
      './node_modules/@remotion/google-fonts/**/*',
      './node_modules/@remotion/transitions/**/*',
      './src/remotion/**/*',
      './src/lib/**/*',
    ],
    '/api/render/video': [
      './node_modules/@rspack/**/*',
      './node_modules/remotion/**/*',
      './node_modules/@remotion/google-fonts/**/*',
      './node_modules/@remotion/transitions/**/*',
      './src/remotion/**/*',
      './src/lib/**/*',
    ],
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
