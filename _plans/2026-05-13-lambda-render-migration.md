# 2026-05-13 — Migrate long-form video rendering to AWS Lambda

## Goal

Move `/api/render/video` from in-process Vercel `bundle()` + `renderMedia()`
to `@remotion/lambda`'s distributed renderer, so videos longer than ~5
minutes can render at all (Vercel function ceiling is 300s) and shorter
videos render ~20× faster (parallel chunk fan-out). Keep `/api/render/short`
on Vercel — Shorts are 30-60s and finish well under the ceiling.

Success looks like: a 14-minute 1080p video renders in ~75-90 seconds wall
time for ~$0.15 of AWS spend, with the same `renderId` + GET poll API the
frontend already speaks. No frontend changes required.

Pulled prior research from the parent conversation: pricing is verified
live at <https://www.remotion.dev/docs/lambda/cost-example> (2026-05-13);
SSR comparison is verified at <https://www.remotion.dev/docs/compare-ssr>.

## In scope

- Production AWS Lambda + S3 site for the `YouTubeVideo` composition.
- Migrating only `/api/render/video` — the long-form path.
- Cost protection: per-render cost capture, daily spend cap, alerts.
- Deploy automation: a script that redeploys the Remotion site when
  `src/remotion/**` changes.
- Rollback path: feature-flagged so the Vercel path remains intact and
  the toggle can flip back to it inside a single deploy.

## Out of scope (v2+)

- Migrating `/api/render/short`. Shorts hit Vercel's 300s ceiling never;
  there's no benefit. Re-evaluate only if Shorts grow longer or Vercel
  costs spike.
- Webhooks for render completion. Polling already works and matches the
  existing job-status API. Webhook upgrade is a follow-up if the poll
  cadence becomes a problem.
- Multi-region deploy. us-east-1 only for v1 — cheapest and biggest
  Lambda capacity. Same region as Vercel's `iad1` so egress is free.
- Composite overlays (the 34 logo-on-doodle rows in the ransomware CSV).
  Tracked as its own feature; rendering architecture is independent of it.
- Migrating the Remotion Studio away from local. Studio stays local; only
  production rendering goes to Lambda.

## Why Lambda over the alternatives

Already debated in the parent conversation. One-line recap:

- **Lambda** — distributed renderer, ~75-90s wall time for a 14-min
  video, ~$0.15 per render, $0 fixed cost, official Remotion path.
  **Chosen.**
- Vercel Sandbox — same per-render cost, but no distributed rendering
  (~25-40 min wall time). UX-blocking for a creator-facing tool.
- Dedicated Node worker (Fly.io 8GB) — $99-150/mo fixed cost. Only wins
  on per-render cost above ~500 renders/month, which we are nowhere
  near. Reconsider at that volume.

## Phases

### Phase 1 — AWS bootstrap (½ day, one-time)

User-confirmed (2026-05-13): no existing AWS account; create a fresh
one. All of this is a one-time setup. After this phase, AWS recedes into
the background — Remotion's CLI does the rest.

#### 1.1 Create the AWS account (5–10 min)

1. Open <https://aws.amazon.com/> in a private/incognito tab so it
   does not collide with any Google or Amazon retail login. Click
   **Create an AWS Account** (top right).
2. Enter:
   - Root user email — use a project-dedicated address if possible
     (e.g. an alias like `aws+youtubestudio@yourdomain`). The root user
     is the account's keys-to-the-kingdom owner; treat its email like a
     password.
   - AWS account name — `youtubestudio` or similar.
3. Verify the email (AWS sends a 6-digit code).
4. Set a strong root password (16+ chars, password manager).
5. Choose account type **Personal** (Business adds tax fields that don't
   matter for you yet).
6. Fill in contact info.
7. Enter a credit card. AWS does a $1 hold; charges only kick in past
   the free tier. The Phase 5 spend caps prevent runaways even if you
   misconfigure something.
8. Phone verification (SMS or call, six-digit code).
9. Select **Basic Support — Free**.
10. Sign in to the AWS Console as root.

#### 1.2 Lock down the root user (10 min, mandatory)

The root user should be used twice ever: once to do steps 1.3 and 1.4,
once a year if you ever need to recover. Never for daily work.

1. AWS Console → top-right account menu → **Security credentials**.
2. **Multi-factor authentication** → Assign MFA device. Use an
   authenticator app (1Password, Authy, Google Authenticator). Scan QR,
   enter two consecutive codes, save.
3. Confirm there are **zero access keys** under "Access keys (root user)".
   If any exist, delete them. Root must never have programmatic keys.

#### 1.3 Create the IAM admin user you'll actually use (10 min)

Working as root in the daily console is bad practice. Create a normal
human-IAM-user for yourself.

1. AWS Console search bar → "IAM" → open the **IAM** service.
2. Left nav → **Users** → **Create user**.
3. User name: `your-name-admin` (e.g. `yoav-admin`).
4. **Provide user access to the AWS Management Console** → check.
   - **I want to create an IAM user** → choose.
   - Auto-generate password OR custom — your call. Tick "Users must
     create a new password at next sign-in" if auto-generated.
5. **Permissions** → **Attach policies directly** → tick
   **AdministratorAccess**. (You're the admin; this is fine for a single-
   developer account. We will sandbox Remotion separately below.)
6. Review → Create user.
7. **Download the .csv** with the sign-in URL + temporary password.
8. Sign out of root. Sign back in via the new IAM URL (looks like
   `https://<account-id>.signin.aws.amazon.com/console`). Bookmark it.
9. Repeat the MFA dance for this IAM user from
   IAM → Users → your-name-admin → Security credentials → Assign MFA.

From here on, do everything as `your-name-admin`, never as root.

#### 1.4 Install Remotion's Lambda tooling locally (2 min)

```powershell
npm install --save-exact @remotion/lambda@4.0.460
```

(Must match `remotion@4.0.460` to the patch version. Mismatches fail at
deploy.)

#### 1.5 Create the dedicated `remotion-user` IAM principal (15 min)

This is the locked-down principal the app uses. It can only touch
Remotion's S3 buckets + Lambda function — not the rest of your account.

1. Open the project terminal at `c:\youtubestudio`. Run:
   ```powershell
   npx remotion lambda policies user
   ```
   This prints a JSON IAM policy to stdout. Copy it.
2. AWS Console (signed in as your-name-admin) → IAM → **Policies** →
   **Create policy**.
3. Tab → **JSON**. Paste the policy from step 1. Click **Next**.
4. Name: `remotion-user-policy`. Description: "Issued by Remotion CLI".
   Create policy.
5. IAM → **Users** → **Create user**.
6. Username: `remotion-user`. **Do not** check "Provide user access to
   the Management Console" — this user is API-only.
7. Permissions → **Attach policies directly** → search for
   `remotion-user-policy` → tick it. Next → Create user.
8. Open the new user → **Security credentials** tab → **Access keys** →
   **Create access key**.
9. Use case: **Application running outside AWS**. Acknowledge the
   prompt. Skip the description tag. Create.
10. **Download the .csv now.** This is the one and only time AWS shows
    the secret. Save the values into your password manager too as a
    backup.

#### 1.6 Create the Lambda execution role (5 min)

Remotion's Lambdas themselves run under a separate role from the user
that calls them. This is the role-side policy.

1. In the project terminal:
   ```powershell
   npx remotion lambda policies role
   ```
   Copy the printed JSON.
2. AWS Console → IAM → **Policies** → **Create policy** → JSON → paste →
   Next → name `remotion-lambda-role-policy` → Create.
3. IAM → **Roles** → **Create role**.
4. Trusted entity type: **AWS service** → service: **Lambda** → Next.
5. Attach policy: search `remotion-lambda-role-policy` → tick → Next.
6. Role name: **`remotion-lambda-role`** (exact name; Remotion CLI looks
   for this by default).
7. Create role.

#### 1.7 Plug the credentials into the project (3 min)

1. Open the .csv from step 1.5.10. You'll see two values:
   `AWS_ACCESS_KEY_ID=AKIA…` and `AWS_SECRET_ACCESS_KEY=…`.
2. Append to `c:\youtubestudio\.env.local` (do not commit):
   ```
   REMOTION_AWS_ACCESS_KEY_ID=AKIA...
   REMOTION_AWS_SECRET_ACCESS_KEY=...
   ```
   (Remotion's CLI auto-reads the `REMOTION_AWS_*` variants; the
   non-prefixed `AWS_*` variants also work but collide with the existing
   `@aws-sdk/client-s3` usage — keep them separated.)
3. Vercel dashboard → project → Settings → **Environment Variables** →
   add both for **Production** + **Preview** (skip **Development** —
   it's local-only).

#### 1.8 Validate (1 min)

In the project terminal:

```powershell
npx remotion lambda policies validate
```

Expected output: three green checks (user policy ✓, role policy ✓,
buckets ✓). If anything is red, the message says exactly what's wrong;
fix and re-run.

When this returns green, Phase 1 is done. You'll never touch the AWS
Console again unless you're rotating keys or pulling cost reports —
Phases 2–6 are all CLI / code.

### Phase 2 — Initial deploy (1 hour)

1. `npx remotion lambda functions deploy --memory=2048 --timeout=900 --disk=10240 --region=us-east-1`.
   Returns a function name like `remotion-render-4-0-460-mem2048mb-disk10240mb-900sec`.
2. `npx remotion lambda sites create src/remotion/Root.tsx --site-name=youtubestudio-prod --region=us-east-1`.
   Returns a `serveUrl` like `https://remotionlambda-xxxxx.s3.us-east-1.amazonaws.com/sites/youtubestudio-prod/index.html`.
3. Smoke test from CLI: `npx remotion lambda render <serveUrl> YouTubeVideo --props='{"config":{...DEMO_CONFIG...}}'`.
   Confirm an MP4 lands in the S3 outputs prefix and the demo render looks
   correct.

### Phase 3 — Route migration (½ day)

1. Add `src/lib/remotion-lambda.ts`:
   - `kickOffLambdaRender({ compositionId, inputProps, codec })` →
     calls `renderMediaOnLambda` from `@remotion/lambda/client` and
     returns `{ renderId, bucketName }`.
   - `pollLambdaProgress({ renderId, bucketName })` → calls
     `getRenderProgress`; returns the same shape `/api/render/video?GET`
     already returns to the frontend (overallProgress, done, errors,
     outputFile, costs).
   - Lambda function name + site URL come from env vars
     `REMOTION_LAMBDA_FUNCTION_NAME` + `REMOTION_LAMBDA_SERVE_URL`.
2. Update `src/app/api/render/video/route.ts`:
   - Behind a feature flag `RENDER_BACKEND=lambda|vercel` (default
     `vercel` for safety; flip to `lambda` for selected workspaces first).
   - `POST` branch: if backend=lambda, call `kickOffLambdaRender`,
     store `lambda_render_id` + `lambda_bucket` on the `render_jobs`
     row (add columns via migration), kick off a background poll loop
     that updates `progress`, `status`, and `output_url`. Skip the
     local `bundle()` + `renderMedia()`.
   - `GET` branch: read the row; if it has a `lambda_render_id`, fetch
     fresher progress from Lambda before responding.
3. New migration `0066_render_jobs_lambda_columns.ts` (verified next
   free number; existing migrations end at `0065_extend_watchlist_for_searches.ts`):
   ```sql
   ALTER TABLE render_jobs
     ADD COLUMN IF NOT EXISTS lambda_render_id TEXT,
     ADD COLUMN IF NOT EXISTS lambda_bucket    TEXT,
     ADD COLUMN IF NOT EXISTS estimated_cost   REAL;
   ```
4. Output handling: Lambda writes the MP4 to S3 with `privacy: 'public'`
   by default. Two paths:
   - **Path A**: serve directly from S3 — `output_url` = Lambda's S3
     public URL. Simpler, one fewer hop, $0.023/GB-month storage.
   - **Path B**: copy to Vercel Blob to match `/api/render/video`'s
     current contract — slower (extra download + upload), more
     consistent for the consumer.
   Default for v1: **Path A** with a TODO to revisit if support gets
   confused about two URL shapes. See open question Q2.

### Phase 4 — Deploy automation (1-2 hours)

1. Add `scripts/deploy-remotion-site.ts`:
   - Imports `deploySite` from `@remotion/lambda`.
   - Reads `REMOTION_LAMBDA_BUCKET_NAME` + `REMOTION_LAMBDA_REGION`
     from env.
   - Deploys with `siteName: 'youtubestudio-prod'` (overwrite-in-place
     behavior — no version churn).
   - Writes the resulting `serveUrl` to stdout so CI can capture it.
2. Add npm script: `"deploy:remotion": "tsx scripts/deploy-remotion-site.ts"`.
3. Document the manual workflow: `npm run deploy:remotion` after any
   change to `src/remotion/**` or `src/lib/shorts-render-types.ts`.
4. Optional v1.1: GitHub Action triggered on push to main that detects
   changes under `src/remotion/**` and runs the deploy script with
   secrets from Vercel env.

### Phase 5 — Cost protection (½ day) — IMPLEMENTED 2026-05-13

Per CLAUDE.md rule 8: any feature with cost implications gets explicit
guardrails.

**Code (done in `src/lib/remotion-lambda-quotas.ts` + the route):**

1. Env vars (all optional, with safe defaults):
   - `LAMBDA_MAX_SPEND_USD_PER_DAY` — default 5 USD.
   - `LAMBDA_MAX_SPEND_USD_PER_RENDER` — default 1 USD (catches runaway
     long videos).
   - `LAMBDA_MAX_CONCURRENT_RENDERS` — default 5.
2. `preflightLambdaQuota()` runs on every `POST /api/render/video`
   before a row is created. It refuses with 429 + `Retry-After` header
   when the rolling-24h spend or the in-flight count meets cap.
3. `shouldKillForOverspend()` runs on every GET poll. If accrued cost
   exceeds the per-render cap, `killOverspendingRender()` calls
   `deleteRender` on Lambda and the local row is marked `'error'`.
4. Final cost is captured in `estimated_cost` on every GET poll (not
   only at completion), so the daily-budget query reflects in-flight
   spend instead of only completed renders.

**Manual one-time AWS Console step — CloudWatch tripwire alarm:**

A runaway-loop tripwire alarm fires if Lambda invocations spike beyond
the legitimate ceiling. Defense-in-depth: catches misbehavior the in-app
caps can't (e.g. a leaked credential used by a third party).

1. AWS Console → search "CloudWatch" → open the service.
2. Left nav → **Alarms** → **All alarms** → **Create alarm**.
3. **Select metric** → AWS/Lambda → **By Function Name**.
4. Find the row for `remotion-render-4-0-460-mem2048mb-disk10240mb-900sec`
   (your function name) and check the `Invocations` metric. Click
   **Select metric**.
5. Statistic: `Sum`. Period: `5 minutes`.
6. Conditions: **Static** → **Greater** → **100**. Click Next.
7. Notification → Create new SNS topic → name `remotion-runaway-alerts`
   → enter your email → Create topic. Confirm the email subscription
   (AWS sends a verification link).
8. Alarm name: `remotion-render-runaway-tripwire`.
   Description: `Alerts when Lambda invocations exceed 100 / 5min.
   Indicates a runaway loop, credential abuse, or test script gone wrong.`
9. Create alarm.

The alarm is purely a paging channel — the in-app caps remain the
authoritative budget control. Email arrives ~1 minute after the spike.

### Phase 6 — Validation + cutover (½ day) — IN PROGRESS 2026-05-13

**Code done:** [scripts/lambda-smoke.ts](../scripts/lambda-smoke.ts)
exercises the end-to-end Lambda path (kickoff → poll → S3 output) using
a 1.5-second `YouTubeVideo` composition that costs roughly $0.001 per
run. Invoked with `npm run smoke:lambda`. Validates AWS credentials,
function reachability, site bundle, and progress polling without
touching the UI.

**Operational runbook (creator-driven, 1-week soak):**

1. **Day 0** — confirm `RENDER_BACKEND=lambda` is set in `.env.local`,
   migration 0066 is applied (`npm run db:status` should show it
   green), and `npm run smoke:lambda` returns a valid `outputFile` URL.
   The first browser hit to that URL should play the 1.5s clip
   immediately.
2. **Day 0** — render a real, full production-doc video through the
   UI. Confirm:
   - The `Render` button returns a renderId in <500ms (Lambda kicks off
     remotely; no in-process bundling).
   - The progress bar advances and reaches 100%.
   - The output URL is an S3 URL of the form
     `https://remotionlambda-useast1-…s3.us-east-1.amazonaws.com/renders/…mp4`
     and plays in the browser.
   - Audio sync is right (spot-check a few seconds 1/3 + 2/3 through).
   - On-screen text + LowerThird overlays look identical to the Vercel
     output. If you have a recent Vercel-rendered version of the same
     doc, A/B them.
3. **Day 0** — open the AWS Console → Billing → Cost Explorer. Confirm
   you can see today's Lambda + S3 spend lines after a 30-60 minute
   delay (AWS billing is not real-time).
4. **Days 1-7** — render normally. Watch for:
   - Any render that lands in `'error'` state with the per-render-cap
     message (`Render exceeded per-render cap …`) — surfaces in the
     `render_jobs` row's `error` column. If false-positive (legit
     long video tripped the $1 cap), bump `LAMBDA_MAX_SPEND_USD_PER_RENDER`.
   - Rolling-24h spend approaching the $5 cap — query:
     `SELECT SUM(estimated_cost) FROM render_jobs WHERE started_at >= NOW() - INTERVAL '24 hours' AND lambda_render_id IS NOT NULL;`
   - CloudWatch tripwire email (Phase 5) — investigate immediately if
     it fires.
5. **Day 7** — if no surprises, mark cutover complete. Document the
   final-week stats (count of renders, total spend, p95 wall time) for
   future reference.

**Decommission plan (deferred to 2026-05-27, 2 weeks after Day 7):**

1. Remove the Vercel branch from `POST /api/render/video`:
   - Delete the `startRender` function (the in-process bundler/renderer).
   - Delete the `selectRenderBackend` helper.
   - Always call `startLambdaRender`.
   - Delete the `maxDuration = 300` export (no longer needed once the
     function returns in ~200ms).
2. Remove `@remotion/bundler` and `@remotion/renderer` from
   `dependencies` if no other route uses them. (Confirmed users:
   `/api/render/short` — keep these deps until that route also moves
   off Vercel-side rendering.)
3. Keep `GET /api/render/video` endpoint shape exactly as-is — clients
   are stable on the response field set.
4. Update [package.json](../package.json) — delete `RENDER_BACKEND` env
   reference in the route is the only code change.
5. Bump the plan to a "completed" status with a one-paragraph
   retrospective.

## Security (rule 13)

- **Credentials.** AWS access key + secret stored in Vercel env + local
  `.env.local`. **Never** committed. The `remotion-user` IAM principal
  has only the Remotion-generated inline policy attached — least
  privilege, scoped to the Remotion S3 bucket + Lambda function.
- **S3 bucket privacy.** Outputs default `privacy: 'public'` for direct
  serve. Acceptable because output URLs already share that property in
  Vercel Blob. If outputs ever contain non-public content (private
  drafts, watermarked previews), switch to `privacy: 'private'` and
  serve via `presignUrl` from `@remotion/lambda/client`.
- **Input validation.** Existing `validateConfig()` in
  `/api/render/video/route.ts` stays. Lambda receives the same already-
  validated config. No new attack surface from migration alone.
- **Cost as a security concern.** A misbehaving caller can rack up
  Lambda invocations. The Phase 5 caps + CloudWatch alarm are the
  defense. Hard cap (refuse-to-render) is the user-overridden version
  of the council recommendation in `_plans/2026-05-12-auto-pipeline.md`
  — re-applying the same pattern here.
- **Lambda → S3 trust.** Remotion's renderer Lambdas write to the S3
  bucket the function was deployed with. They cannot reach the Vercel
  Postgres DB or any other AWS resource. Blast radius of a compromised
  Lambda is the S3 bucket only.
- **No PII or credentials in Lambda inputs.** `inputProps` carries only
  the `VideoConfig`: shot list, brand kit, audio URLs. The
  `voiceoverUrl` is a Vercel Blob public URL by the time it reaches
  here — no signed token leaking via render logs.

## UX walk-through (rule 10)

The lazy-user path through this, after migration:

1. User on `/production-doc` page clicks "Render Video".
2. POST `/api/render/video` returns `{ renderId }` in ~200ms (just
   kicked off the Lambda main function; no local bundling).
3. UI swaps the button for a progress bar at 0%.
4. UI polls GET `/api/render/video?renderId=…` every 2-3s.
5. Backend reads `render_jobs` row, fetches fresher progress from
   `getRenderProgress`, returns `{ progress, status, output_url? }`.
6. Progress smoothly climbs to ~95% over ~75-90s for a 14-min video
   (Lambda's chunk fan-out makes progress non-linear but always
   increasing).
7. At 100%, `status='done'` + `output_url=<S3 URL>`. UI shows the MP4
   in a player + a download button.
8. **What if the tab closes?** Same as today: the job continues in the
   background (Lambda runs independently of the Vercel function). When
   the user comes back, polling resumes and finds either `status='done'`
   or fresh progress. No work lost.
9. **What if the user clicks Render twice?** Each click creates a new
   `renderId`. Same as today. Concurrent-cap (Phase 5) prevents abuse.
10. **What if Lambda fails mid-render?** `status='error'` + `error`
    message. UI shows a retry button. Same as today.

## Resolved questions (2026-05-13 with user)

1. **Which AWS account?** Fresh dedicated AWS account — user has none
   today. Phase 1 walks through creation from zero.
2. **Output URL contract — Path A or Path B?** Path A (serve directly
   from S3). Simpler, cheaper, one fewer hop. Revisit only if a private-
   draft requirement emerges.
3. **Spend caps.** Defaults stand: $5/day, $1/render, 5 concurrent.
   User is launching, not yet at scale — conservative is correct.
4. **Migration ordering.** Long-form `/api/render/video` only. Shorts
   stay on Vercel until they outgrow the 300s ceiling.
5. **Cutover style.** Feature flag `RENDER_BACKEND=lambda|vercel`,
   default Vercel until soak passes. Flip default after one week of
   clean renders for the author's workspace.

## Decision log

- **Chose Lambda over Vercel Sandbox** — Sandbox lacks distributed
  rendering; ~30 min wall time vs ~90 sec is creator-facing UX-blocking.
  Verified at <https://www.remotion.dev/docs/compare-ssr>.
- **Chose Lambda over dedicated Fly.io worker** — break-even with Fly
  is ~500 renders/month; current volume is well below.
- **Did NOT migrate Shorts** — 30-60s renders finish on Vercel in
  ~5-30s. No UX or technical reason to add Lambda complexity for them.
- **Did NOT add webhooks in v1** — polling matches existing job-status
  contract. Webhooks are nice but additive; defer.
- **Did NOT council this decision** — author judged the data
  unambiguous (live pricing + Remotion's own primary recommendation).
  If user pushes back on the recommendation, council it then.

## Cost estimate (concrete)

Verified live from <https://www.remotion.dev/docs/lambda/cost-example>
on 2026-05-13.

- Setup: $0 (AWS free tier covers function + site creation; test renders
  cost cents).
- Per render of a 14-min 1080p video at 2048MB: **$0.14-0.18**
  (extrapolated from Remotion's $0.103 example for a 10-min HD render).
- S3 storage: ~$0.023/GB-month. A 14-min HD MP4 is ~50-100MB.
- At 100 renders/month: ~$15 compute + ~$0.50 storage = **~$16/month**.
- At 500 renders/month: ~$75 + ~$2.50 = **~$78/month**.
- Egress to viewers: free if the viewer is in the same region as the
  S3 bucket; ~$0.09/GB out otherwise. If MP4s are served to the public
  internet, factor ~$5-10/month at 100 viewers per render.

## Effort estimate

- Phase 1 (AWS bootstrap): ½ day
- Phase 2 (initial deploy): 1 hour
- Phase 3 (route migration): ½ day
- Phase 4 (deploy automation): 1-2 hours
- Phase 5 (cost protection): ½ day
- Phase 6 (validation + cutover): ½ day

**Total: ~2-3 days of focused work, plus a 1-week soft-rollout watch
window before the default flips.**
