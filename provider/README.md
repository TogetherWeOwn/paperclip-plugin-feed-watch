# Request-only transcript provider

This optional single-process Node service implements the existing feed-watch
`POST /transcript` contract when the Worker cannot acquire a caption track.
It has no poller, WebSub endpoint, Paperclip credentials, or task-writing code.
Only the internal research consumer should receive its shared secret. It is not
a general-purpose caption API or an HTTP proxy.

## Configuration and deployment

Build from the repository root:

```sh
docker build -f provider/Dockerfile -t feed-watch-transcript-provider .
```

Required environment variables (keep the actual environment file private):

- `SHARED_SECRET`: a new random secret, at least 32 characters. Store the same
  value as a company secret and configure the plugin's `transcriptSecretRef`.
- `CHANNEL_ID`: exactly the plugin's allowed channel.
- `YOUTUBE_PROXY_URL`: the operator-provided HTTP(S) egress proxy. Both player
  and timed-text requests use this proxy; there is no direct fallback.

Mount a named volume at `/data`, run **one replica only**, bind its port 8080 to
loopback, and put a TLS reverse proxy in front. Use a read-only root filesystem,
non-root user, dropped capabilities, no-new-privileges, and a 128 MiB memory cap.
Use `transcriptProviderUrl` for the public HTTPS ingress; do not expose the
outbound proxy itself. The service needs write access only to `/data`.

`GET /healthz` returns only `{"ok":true}`. All other routes except
`POST /transcript` return 404. The signed request body is exactly
`{"videoId":"<video-id>","channelId":"<allowed-channel>"}`. Authentication reuses
`src/crypto.ts` without changing its timestamp/route/body binding. Responses use
the plugin's existing video/language/source/retrievedAt/raw/segments contract.
Unsigned or stale requests return 401; invalid input returns 400; cooldown or
concurrent acquisition returns 429; upstream failures return 502; storage failure
returns 503 and prevents further acquisition until repaired/restarted.

## Egress and durable budget

The service reserves each attempt in `/data/state.json` before issuing network
traffic: at most 96 attempts per UTC day with 60 seconds between starts. An
upstream HTTP 403 or 429 persists a six-hour cooldown, including across UTC day
rollover and container restarts. Atomic rename and file/directory sync preserve
state; corrupt state fails startup instead of resetting the budget. Do not
remove or reset the state volume to bypass these controls.

Acquisition follows the Worker's Android player request and caption parser.
Channel membership is checked against the player's details; only HTTPS
`youtube.com` / `www.youtube.com` `/api/timedtext` track URLs are allowed, with
redirects refused and `tlang` removed. Signed track URLs, proxy credentials,
shared secrets and upstream error bodies are never returned or logged. Only
the budget is stored locally; transcript content is returned to the consumer.

The proxy agent and fetch implementation come from the same pinned Undici
version. Node's bundled fetch may use a different dispatcher protocol.

## Verification and rollout

Run `npm run check` at the repository root. Provider tests cover authentication,
channel and URL restrictions, the transcript contract, proxy dispatch (including
a real local CONNECT test), persisted spacing/cooldown/daily limits, concurrency,
oversized input, malformed captions, and corrupt-state refusal.

Keep feed-watch disabled while checking public health and unsigned rejection,
then run one signed transcript acceptance request before enabling pull-only.
Observe exactly one correctly assigned research card with transcript documents
before proceeding to the existing Worker subscription/status lease checks.
Do not retire an older intake path until 48 hours of matching output. Rollback
is to disable intake, restore the previous company config, stop this container,
and remove its ingress/DNS record; retain the state volume while diagnosing.
