<!-- BEGIN:nextjs-agent-rules -->
# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` before writing any code. Heed deprecation notices.
<!-- END:nextjs-agent-rules -->

# Database

Migrations run automatically on every Vercel deploy via the `vercel-build` script in `package.json` (`tsx scripts/migrate.ts up && next build`). A failed migration fails the build, so new code never goes live against an old schema. No manual `npm run db:migrate` is needed before pushing a feature that adds a column or table. Local dev still runs `npm run db:migrate` and `npm run db:status` as needed.
