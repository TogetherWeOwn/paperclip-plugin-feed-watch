# Paperclip Feed Watch

Deterministic YouTube **discovery only**: RSS/WebSub in, one unassigned stub card per new video out. **Both the plugin and Cloudflare Worker default to disabled. This repository is an uninstalled, undeployed implementation, not a live watcher.**

The first supported source is AI Engineer (`UCLKPca3kwwd-B59HNr-_lvA`). Detection, subscription maintenance, deduplication and stub issuance make **zero inference calls**. This plugin never fetches captions: fetching a video's real subtitles and analyzing them is external pipeline work (see *Transcripts live elsewhere*). Research is ordinary visible Paperclip work; implementing a technique is a separate applicability/design/review decision, not something a webhook authorizes.

## Boundaries

- A native `poll` job runs every **15 minutes**. It reconciles RSS, drains a bounded durable inbox page, renews the actual granted WebSub lease, and issues stub cards for newly discovered videos. No host timer, cron, hook, Worker cron, direct DB write or Paperclip core patch.
- YouTube WebSub requires GET challenge verification and Atom/XML delivery. Paperclip's plugin ingress is JSON POST-only. The Worker is only a protocol adapter and durable inbox, **not another agent scheduler**.
- The optional signed Worker → Paperclip push persists discovery immediately. **Only the next native poll job creates cards** (up to 15-minute processing latency). Pull-only operation omits `PLUGIN_WEBHOOK_URL` and leaves `webhookEnabled:false`.
- Empty polls never assign a card, invoke an agent, post a comment, choose a model, or call an inference provider.
- Stubs are created in `backlog`, **unassigned**: assignment would wake an agent that has no transcript yet. Each stub carries the video link and its RSS publish date, plus one immutable `source` provenance document (written and read back before the video counts as stubbed).
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
4. Keep `{ "enabled": false }` until company scope, migration boundary, scoped Worker/KV permissions and included resource limits are verified.
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
       "publishedAfter": "2026-10-23T00:00:00Z",
       "initialLastSeen": "<last-reconciled-11-character-video-id>",
       "seedVideoIds": [],
       "workerUrl": "https://<worker-host>",
       "workerSecretRef": {"type":"secret_ref","secretId":"<company-secret-uuid>","version":"latest"},
       "webhookEnabled": false,
       "maxVideosPerTick": 1
     }
   }
   ```

   The placeholders are intentionally invalid. Resolve real IDs through Paperclip MCP; do not copy tenant IDs into public defaults. Secret values never go in config. Each resolution passes its exact `configPath`, avoiding ambiguous bindings when the same secret ID is referenced twice.
7. After staging gates pass, enable the relevant company and Worker explicitly. Native job list/trigger APIs are `GET /api/plugins/:pluginId/jobs` and `POST /api/plugins/:pluginId/jobs/:jobId/trigger` (use the returned **job ID**, not `poll`). No host wrapper is needed.

### Configuration additions

| Field | Meaning |
| --- | --- |
| `publishedAfter` | Required explicit bootstrap boundary; older sources are excluded, even in gap recovery. Choose deliberately during migration. |
| `initialLastSeen` | Exact corpus checkpoint for bootstrap. Used until a native checkpoint is established, including recovery from an incomplete bootstrap. Required when the chosen boundary predates every item in the current RSS tail; otherwise health remains `bootstrap-coverage-unverified` and the checkpoint is not advanced. Enables immediate gap recovery beyond the RSS window. |
| `seedVideoIds` | IDs explicitly accepted as handled elsewhere. Existing native provenance is also queried before creation. |
| `youtubeApiKeyRef` | Optional company secret-ref for paginated long-gap recovery. Verify YouTube Data API access before promising long-outage coverage. |
| `maxVideosPerTick` | 1–5, default 1. Stub cards issued per native job run. |

**Removed in 0.2.0 (breaking config change):** `researchAgentId`, `catalogUrl`, `transcriptProviderUrl`, `transcriptSecretRef`, `retryRequests` and `maxCaptionAttempts` are gone with the transcript leg. Drop them from any stored company config; the strict schema rejects unknown keys.

HTTPS configuration URLs cannot contain credentials, query strings or fragments. The SDK's pinned, SSRF-checked `ctx.http.fetch` is used for plugin egress. **It does not allow an arbitrary private-network proxy URL.** Do not bypass egress protections or expose residential egress through this public Worker; caption fetching does not belong here at all.

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

The Worker records pending intent **before** contacting the hub. The actual `hub.callback` additionally includes an unguessable verification capability generated once in KV and kept stable across renewals (callback URL plus topic identifies a subscription). The configured base callback remains query-free. This capability is omitted from `/status` and plugin health. It answers only a matching, unexpired topic/mode/capability verification GET, returns the exact text challenge with `nosniff`, and records the **granted**, not requested, `hub.lease_seconds`. The native job requests renewal at 80% of that lifetime; a pending/no-confirmed or expired lease is degraded, never reported as subscribed. Pending attempts expire after ten minutes, giving bounded retry on the next job. Keep the granted lifetime comfortably longer than the job interval. No live subscription is claimed by this repository.

YouTube sends metadata edits as well as uploads. The Worker verifies `X-Hub-Signature` over original bytes (SHA-1 or SHA-256), bounds XML to 256 KiB, rejects DTD/entities and nonconfigured channels, and writes immutable content-hash inbox keys **before** returning 202. Events have no unacknowledged TTL. Authentication for internal JSON is a separate SHA-256 HMAC over method, path/purpose, timestamp and exact body, with a five-minute window. No reusable bearer or hub secret is forwarded into Paperclip delivery logs.

For Worker HTTP APIs the signed path includes the query string. Because native `onWebhook` supplies no request URL, push signs the fixed purpose `/paperclip-feed-watch/youtube`, not the installed plugin's UUID route. Tenant/channel and entries remain bound inside the signed body.

Optional push acknowledges/deletes the inbox event only after native durable intake succeeds. If push fails, the native job pulls it. Pull acknowledgements occur only after native state is saved. A 30-day ack receipt handles redelivery; eventual KV visibility/deletion races are harmless to video deduplication. The consumer rotates bounded pages and rescans from the beginning, not a fragile monotonic hash cursor. One serialized native consumer is mandatory; do not install parallel issuers against the same company/channel.

## Transcripts live elsewhere

Fetching subtitles is not a Paperclip feature, so it is not in this plugin. There is no caption parser, no Innertube/player lookup, no `/transcript` route on the Worker, and no transcript provider service in this repository. Datacenter and Worker egress also hit YouTube's bot wall, so this code could never fetch captions reliably anyway.

The pipeline this plugin feeds is: **real subtitles → analysis → knowledge base**, run outside Paperclip. A host-side fetcher with suitable egress downloads each video's native caption track verbatim; analysis and synthesis run against those transcripts, keyed by the video ID and the publish date this plugin records on the stub card and its `source` document. Nothing here substitutes summaries, thumbnails or video "understanding" for the actual subtitles.

The stub's provenance document is independently labeled UNTRUSTED SOURCE DATA and fenced with a delimiter longer than any source backtick run. It records the feed entry (video ID, channel, title, published/updated, canonical URL), discovery time, and `transcript: pending-external-fetch`. Existing documents with conflicting content are never automatically overwritten. State written by pre-0.2.0 versions (caption/research stages) is normalized on read: a record that already owns a card counts as stubbed, one without a card still gets its stub; no card is re-issued and no document is rewritten.

## Recovery, observability and limits

- RSS polling uses the populated `https://www.youtube.com/feeds/videos.xml` endpoint, **not** the documented WebSub `/xml/feeds/` topic. The feed holds only about 15 videos.
- If the exact last-seen ID leaves that window, recovery calls `channels.list(contentDetails)` and paginated `playlistItems.list(maxResults=50)` until the checkpoint. Requests use `x-goog-api-key`, not a secret query parameter. Recovery is bounded at 20 pages. Missing key, absent/deleted checkpoint or page exhaustion is explicit degraded state and **does not advance the checkpoint**. Arbitrary never-miss/outage guarantees are not made.
- Plugin health exposes queue depth/oldest age, last successful RSS check, stale checks, observed lease, stage/error/retry/card IDs and degraded transports. `stub-created` means only that discovery handed off a stub; transcript and research completion are tracked by the external pipeline and native issues, never claimed here.
- Paperclip issue creation has no inspected uniqueness/idempotency guarantee for `originId`. The single writer persists create intent first and queries exact plugin origin/video provenance before every attempt. A committed-but-lost response is recovered without a duplicate. An unresolved attempt with **no matching issue** is deliberately quarantined as `ambiguous-create`, including the crash-before-send case. Re-run the native job to reconcile a late commit. If no issue ever exists, inspect the failed delivery/run and use a separately reviewed SDK-state recovery; **never reset state blindly, write the DB, or create another card manually**. This favors duplicate prevention over unsafe automatic liveness.
- Stub issuance selects least-recently-attempted eligible records, then publication time. The per-tick cap still applies; an old quarantined create or document conflict cannot monopolize all newer intake.
- State retains handled IDs and ingestion records; company-scoped native state should be backed up. Large multi-year feeds may need a reviewed partition/compaction migration. The initial implementation does not bundle an unrelated catalog-search service, publisher or autonomous implementation runner.
- Public native webhook requests are logged by Paperclip **before** plugin verification. Prefer pull-only unless push is needed; review upstream/WAF size/rate controls and delivery-log retention before exposing it. A signed notification is source data, not approval to spend, change security, or execute code.

### Cutover gates (future work, not completed here)

1. Offline replay/restart tests plus isolated staging install/config tests.
2. Real hub subscribe → matching GET challenge → granted lease → signed delivery; real Worker-origin native ingress if push is enabled; successful granted-lease renewal.
3. One correctly deduplicated, unassigned stub card per new video, carrying its link and publish date; no inference/agent wake on empty ticks.
4. RSS fallback plus long-gap pagination with a real authorized API key; restart and ambiguous-create recovery.
5. Reconcile seed IDs / the bootstrap marker against the external corpus before enabling issuance, so already-handled videos are not re-stubbed.
6. Retire this plugin entirely once the external knowledge-base pipeline's own RSS discovery is proven; until then it stays discovery-only. Do not leave two discovery issuers active indefinitely.

Rollback: disable company intake, disable optional Worker intake/push, preserve native checkpoints/documents and unacknowledged inbox records. Do not add a host pacer or delete deduplication state.

## Source contracts researched

Inspected in the running Paperclip container (2026-10-25):

- `/app/packages/plugins/sdk/src/types.ts`: `ctx.jobs.register`, `ctx.state`, `ctx.http.fetch`, object-shaped `ctx.secrets.resolve`, `ctx.issues.create/list` and **`ctx.issues.documents`**.
- `/app/packages/plugins/sdk/src/define-plugin.ts`: `definePlugin({setup,onWebhook,onHealth,onValidateConfig})` and sealed `.definition` wrapper; `runWorker` bootstrap.
- `/app/packages/shared/src/types/plugin.ts` and `/app/doc/plugins/PLUGIN_SPEC.md`: manifest jobs/capabilities/company settings, native scheduling and supported issue/document work.
- `/app/server/src/routes/plugins.ts`: actual install/config/job-trigger payloads; POST-only webhook route and pre-verification delivery logging.
- `/app/server/src/services/plugin-host-services.ts` and `plugin-secrets-handler.ts`: company/origin restrictions, pinned egress and exact secret-ref binding paths.

Official protocol references: [YouTube push notifications](https://developers.google.com/youtube/v3/guides/push_notifications), [WebSub verification and authenticated distribution](https://www.w3.org/TR/websub/), [channels.list](https://developers.google.com/youtube/v3/docs/channels/list), [playlistItems.list](https://developers.google.com/youtube/v3/docs/playlistItems/list), [Cloudflare KV consistency](https://developers.cloudflare.com/kv/concepts/how-kv-works/).

MIT licensed.
