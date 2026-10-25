# Paperclip Feed Watch

Deterministic YouTube intake → full subtitles → one prepared research card per video. **Both the plugin and Cloudflare Worker default to disabled. This repository is an uninstalled, undeployed implementation, not a live watcher.**

The first supported source is AI Engineer (`UCLKPca3kwwd-B59HNr-_lvA`). Detection, subscription maintenance, deduplication and subtitle acquisition make **zero inference calls**. Research is ordinary visible Paperclip work; implementing a technique is a separate applicability/design/review decision, not something a webhook authorizes.

## Boundaries

- A native `poll` job runs every **15 minutes**. It reconciles RSS, drains a bounded durable inbox page, renews the actual granted WebSub lease, retries captions, and prepares cards. No host timer, cron, hook, Worker cron, direct DB write or Paperclip core patch.
- YouTube WebSub requires GET challenge verification and Atom/XML delivery. Paperclip's plugin ingress is JSON POST-only. The Worker is only a protocol adapter and durable inbox, **not another agent scheduler**.
- The optional signed Worker → Paperclip push persists discovery immediately. **Only the next native poll job creates cards** (up to 15-minute processing latency). Pull-only operation omits `PLUGIN_WEBHOOK_URL` and leaves `webhookEnabled:false`.
- Empty polls never assign a card, invoke an agent, post a comment, choose a model, or call an inference provider.
- Assignment occurs only after every source/transcript/plan document has been written and read back. Paused, terminated or pending-approval researchers are never assigned or resumed.
- No corpus, tenant bindings, credentials, operational dumps or signed caption URLs belong in this public repository.

## Build and verify (no deployment)

Node **24.11.0+**, npm **11.19.0**:

```sh
npm ci --ignore-scripts
npm run check
npm audit
```

`check` runs strict TypeScript, offline Node tests (including the real SDK testing harness), and builds the plugin and Worker bundles. Dependencies are pinned; install scripts are disabled in `.npmrc`. No GitHub Actions or paid test infrastructure is added.

The npm SDK release is pinned to `@paperclipai/plugin-sdk@2026.1023.0`; the inspected running host labels its SDK `1.0.0`. The implementation was also typechecked against that installed SDK's actual declarations, not a hand-written substitute. Recheck contracts when upgrading Paperclip.

## Installation plan — deliberately NOT executed

1. Review this PR and its offline tests. Use an isolated staging company/runtime for active acceptance tests, never production canaries. Verify the installed SDK contracts below and local-plugin support on the target host.
2. Build a clean checkout and make the **entire package**, its `dist/` and installed runtime dependencies available at an absolute **container-visible** path. A host checkout is not automatically visible inside Paperclip.
3. An instance administrator may install through the native plugin UI/API. The real HTTP payload is **not** `{localPath:...}`:

   ```http
   POST /api/plugins/install
   Content-Type: application/json

   {"packageName":"/plugins/paperclip-plugin-feed-watch","isLocalPath":true}
   ```

   Internally the route turns `packageName` into the manager's `localPath`. Cloud-managed instances permit only bundled-catalog paths; do not bypass that restriction.
4. Keep `{ "enabled": false }` until company scope, migration boundary, assignee availability, transcript connectivity, scoped Worker/KV permissions and included resource limits are verified.
5. Provision the Worker from `dist/cloudflare.js` using the separately reviewed `cloudflare/wrangler.jsonc` template. This is a **future operator step**, not a command run by this change. Provision its two distinct secrets through the supported secrets mechanism. No new spending or credential rotation is assumed.
6. Save full **company-scoped** configuration through native settings:

   ```http
   POST /api/plugins/<installed-plugin-id>/config
   Content-Type: application/json

   {
     "companyId": "<company-uuid>",
     "configJson": {
       "enabled": false,
       "channelId": "UCLKPca3kwwd-B59HNr-_lvA",
       "projectId": "<existing-project-uuid>",
       "researchAgentId": "<available-existing-agent-uuid>",
       "publishedAfter": "2026-10-23T00:00:00Z",
       "initialLastSeen": "<last-reconciled-11-character-video-id>",
       "seedVideoIds": [],
       "workerUrl": "https://<worker-host>",
       "workerSecretRef": {"type":"secret_ref","secretId":"<company-secret-uuid>","version":"latest"},
       "catalogUrl": "https://<existing-catalog-view>",
       "webhookEnabled": false,
       "maxVideosPerTick": 1,
       "maxCaptionAttempts": 12
     }
   }
   ```

   The placeholders are intentionally invalid. Resolve real IDs through Paperclip MCP; do not copy tenant IDs into public defaults. Secret values never go in config. Each resolution passes its exact `configPath`, avoiding ambiguous bindings when the same secret ID is referenced twice.
7. After staging gates pass, enable the relevant company and Worker explicitly. Native job list/trigger APIs are `GET /api/plugins/:pluginId/jobs` and `POST /api/plugins/:pluginId/jobs/:jobId/trigger` (use the returned **job ID**, not `poll`). No host wrapper is needed.

### Configuration additions

| Field | Meaning |
| --- | --- |
| `publishedAfter` | Required explicit bootstrap boundary; older sources are excluded, even in gap recovery. Choose deliberately during migration. |
| `initialLastSeen` | Optional exact corpus checkpoint used only when no native channel state exists. Enables immediate gap recovery beyond the RSS window. |
| `seedVideoIds` | IDs already researched or explicitly accepted as handled. Do not seed transcript-only videos as researched; leave their needed research in scope. Existing native provenance is also queried before creation. |
| `youtubeApiKeyRef` | Optional company secret-ref for paginated long-gap recovery. Verify YouTube Data API access before promising long-outage coverage. |
| `transcriptProviderUrl`, `transcriptSecretRef` | Optional approved alternative provider implementing the authenticated `/transcript` contract. The provider uses the same timestamp/method/path/body HMAC; no generic URL-fetch relay. |
| `retryRequests` | Map of video ID → fresh UUID nonce. Once per nonce, a caption-blocked record is retried on the native job, reusing its card. No wake-only comment. |
| `maxVideosPerTick` | 1–5, default 1. Use 1 with the Worker: its 60-second minimum acquisition spacing intentionally rejects bursts. |
| `maxCaptionAttempts` | 2–100, default 12. Exponential retry from 30 minutes up to 24 hours. Exhaustion leaves an unwoken backlog card and a degraded health entry, not silent loss. |

HTTPS configuration URLs cannot contain credentials, query strings or fragments. The SDK's pinned, SSRF-checked `ctx.http.fetch` is used for plugin egress. **It does not allow an arbitrary private-network proxy URL.** An internal transcript connector needs its own reviewed native/plugin integration; do not bypass egress protections or expose residential egress through this public Worker.

## Worker and WebSub

Required bindings: `INBOX` (KV), `CHANNEL_ID`, `COMPANY_ID`, `CALLBACK_URL=https://<worker-host>/websub`, `SHARED_SECRET`, `HUB_SECRET`, and explicit `ENABLED=true`. Secrets must be distinct and at least 32 characters. `SHARED_SECRET` matches the company's `workerSecretRef`; `HUB_SECRET` remains exclusively in the Worker/hub exchange. Optional `PLUGIN_WEBHOOK_URL` is the exact native `/api/plugins/<installed-id>/webhooks/youtube` route.

The plugin's maintenance job authenticates `GET /status` and `POST /subscription` to the Worker. The Worker then sends the official form request to `https://pubsubhubbub.appspot.com/subscribe`:

```text
hub.mode=subscribe
hub.topic=https://www.youtube.com/xml/feeds/videos.xml?channel_id=<configured-channel>
hub.callback=<configured-worker>/websub
hub.lease_seconds=86400
hub.secret=<Worker-only secret>
```

The Worker records pending intent **before** contacting the hub. It answers only a matching, unexpired topic/mode verification GET, returns the exact text challenge with `nosniff`, and records the **granted**, not requested, `hub.lease_seconds`. The native job requests renewal at 80% of that lifetime; a pending/no-confirmed or expired lease is degraded, never reported as subscribed. Pending attempts expire after ten minutes, giving bounded retry on the next job. Keep the granted lifetime comfortably longer than the job interval. No live subscription is claimed by this repository.

YouTube sends metadata edits as well as uploads. The Worker verifies `X-Hub-Signature` over original bytes (SHA-1 or SHA-256), bounds XML to 256 KiB, rejects DTD/entities and nonconfigured channels, and writes immutable content-hash inbox keys **before** returning 202. Events have no unacknowledged TTL. Authentication for internal JSON is a separate SHA-256 HMAC over method, path/purpose, timestamp and exact body, with a five-minute window. No reusable bearer or hub secret is forwarded into Paperclip delivery logs.

For Worker HTTP APIs the signed path includes the query string. Because native `onWebhook` supplies no request URL, push signs the fixed purpose `/paperclip-feed-watch/youtube`, not the installed plugin's UUID route. Tenant/channel and entries remain bound inside the signed body.

Optional push acknowledges/deletes the inbox event only after native durable intake succeeds. If push fails, the native job pulls it. Pull acknowledgements occur only after native state is saved. A 30-day ack receipt handles redelivery; eventual KV visibility/deletion races are harmless to video deduplication. The consumer rotates bounded pages and rescans from the beginning, not a fragile monotonic hash cursor. One serialized native consumer is mandatory; do not install parallel issuers against the same company/channel.

## Subtitles and full-source research

The Worker implements an **opt-in** Innertube ANDROID `21.26.364` player lookup and caption download, preferring manual English, then English ASR, then an available original language. It verifies player channel identity and allowlists the signed timedtext host/path, disallows redirects, preserves raw captions and all parsed timestamped text, and never returns the signed track URL. No paid transcription is added.

**A Worker is not a proven reliable subtitle path.** Current corpus code documents Cloudflare 403/1010 bot walls and a measured internal player connector with direct-v4/v6 timedtext paths. That operational multi-path connector is **not silently ported into this public Worker**. Verify current connectivity before activation; use only an approved provider, keep residential use internal, and retain caption-pending failures if acquisition is blocked. The Worker backstop persists 60-second spacing, 96 acquisitions/day and six-hour 403/429 cooldown. KV is eventually consistent: these are conservative backstops for the single consumer, not a globally atomic distributed quota guarantee.

A transcript capture is cached durably while preparation is incomplete. Raw source and parsed text are content-addressed, split into complete parts below Paperclip's 524288-character document limit, and read back before assignment. Documents include source URL, language, source hash, retrieval time and the complete part index. Existing documents with conflicting content are never automatically overwritten.

The prepared plan requires complete coverage, English research output, compact catalog candidate retrieval, exact timecoded evidence, current code/task/PR novelty checks, YAGNI and native → plugin → upstream selection. It forbids prompt injection, model-comparison experiments and automatic implementation authority. Useful bounded improvements become linked implementation cards through normal MCP; larger features require a design card/grill-me gate. Native routing/budgets, normal reviews/CI/staging and publishing remain the existing owners' responsibilities.

## Recovery, observability and limits

- RSS polling uses the populated `https://www.youtube.com/feeds/videos.xml` endpoint, **not** the documented WebSub `/xml/feeds/` topic. The feed holds only about 15 videos.
- If the exact last-seen ID leaves that window, recovery calls `channels.list(contentDetails)` and paginated `playlistItems.list(maxResults=50)` until the checkpoint. Requests use `x-goog-api-key`, not a secret query parameter. Recovery is bounded at 20 pages. Missing key, absent/deleted checkpoint or page exhaustion is explicit degraded state and **does not advance the checkpoint**. Arbitrary never-miss/outage guarantees are not made.
- Plugin health exposes queue depth/oldest age, last successful RSS check, stale checks, observed lease, stage/error/retry/card IDs and degraded transports. Research completion remains native issue state; `research-pending` does not mean researched or implemented.
- Paperclip issue creation has no inspected uniqueness/idempotency guarantee for `originId`. The single writer persists create intent first and queries exact plugin origin/video provenance before every attempt. A committed-but-lost response is recovered without a duplicate. An unresolved attempt with **no matching issue** is deliberately quarantined as `ambiguous-create`, including the crash-before-send case. Re-run the native job to reconcile a late commit. If no issue ever exists, inspect the failed delivery/run and use a separately reviewed SDK-state recovery; **never reset state blindly, write the DB, or create another card manually**. This favors duplicate prevention over unsafe automatic liveness.
- State retains handled IDs and ingestion records; company-scoped native state should be backed up. Large multi-year feeds may need a reviewed partition/compaction migration. The initial implementation does not bundle an unrelated catalog-search service, publisher or autonomous implementation runner.
- Public native webhook requests are logged by Paperclip **before** plugin verification. Prefer pull-only unless push is needed; review upstream/WAF size/rate controls and delivery-log retention before exposing it. A signed notification is source data, not approval to spend, change security, or execute code.

### Cutover gates (future work, not completed here)

1. Offline replay/restart tests plus isolated staging install/config tests.
2. Real hub subscribe → matching GET challenge → granted lease → signed delivery; real Worker-origin native ingress if push is enabled; successful granted-lease renewal.
3. Working full-caption path, delayed-caption retry, complete-document preparation, and one correctly assigned research card. Verify current researcher availability and routing/quota controls.
4. RSS fallback plus long-gap pagination with a real authorized API key; no inference/agent wake on empty ticks; restart and ambiguous-create recovery.
5. Import/reconcile the existing company corpus and research outcomes before enabling issuance. Do not label downloaded-only transcripts as researched.
6. Only after native acceptance: retire the old `ai-engineer-transcripts` and `ai-engineer-research` host timer/service paths, reconcile their automation-registry entries and record the native replacement. **This change does not stop or alter either timer.** Do not leave two card issuers active indefinitely.

Rollback: disable company intake, disable optional Worker intake/push, preserve native checkpoints/documents and unacknowledged inbox records. Do not add a host pacer or delete deduplication state.

## Source contracts researched

Inspected in the running Paperclip container (2026-10-25):

- `/app/packages/plugins/sdk/src/types.ts`: `ctx.jobs.register`, `ctx.state`, `ctx.http.fetch`, object-shaped `ctx.secrets.resolve`, `ctx.issues.create/list/update`, **`ctx.issues.documents`** and `ctx.agents.get`.
- `/app/packages/plugins/sdk/src/define-plugin.ts`: `definePlugin({setup,onWebhook,onHealth,onValidateConfig})` and sealed `.definition` wrapper; `runWorker` bootstrap.
- `/app/packages/shared/src/types/plugin.ts` and `/app/doc/plugins/PLUGIN_SPEC.md`: manifest jobs/capabilities/company settings, native scheduling and supported issue/document work.
- `/app/server/src/routes/plugins.ts`: actual install/config/job-trigger payloads; POST-only webhook route and pre-verification delivery logging.
- `/app/server/src/services/plugin-host-services.ts` and `plugin-secrets-handler.ts`: company/origin restrictions, pinned egress and exact secret-ref binding paths.
- Existing acquisition reference: `/home/ubuntu/paperclip-enterprise-company/ops/research/ai-engineer/fetch_transcripts.py` (measured path/cooldowns, not a runner invoked by this plugin).

Official protocol references: [YouTube push notifications](https://developers.google.com/youtube/v3/guides/push_notifications), [WebSub verification and authenticated distribution](https://www.w3.org/TR/websub/), [channels.list](https://developers.google.com/youtube/v3/docs/channels/list), [playlistItems.list](https://developers.google.com/youtube/v3/docs/playlistItems/list), [Cloudflare KV consistency](https://developers.cloudflare.com/kv/concepts/how-kv-works/).

MIT licensed.
