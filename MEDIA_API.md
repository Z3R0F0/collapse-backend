# Media metadata protocol, extension version 1

This is a Collapse extension to pinned Tinode v0.25.3's JSON protocol over its
existing authenticated WebSocket/long-poll transport. It is not a stock Tinode
feature. gRPC/protobuf and database adapters other than PostgreSQL are unchanged.
No new endpoint, token type or authentication flow exists.

The session must first attach to the P2P/group/self topic through ordinary
`sub`. The effective subscription must include Read. Group channel-reader mode
is not supported. Losing Read access takes effect through the same topic actor
as ordinary history. An unauthenticated or unauthorized caller gets a correlated
stock error, without media metadata.

## Request and response

Latest page (default limit 24, maximum 40):

```json
{"get":{"id":"m1","topic":"grpExample","what":"media","media":{"kind":"visual","limit":24}}}
```

Example result, with an illustrative empty page:

```json
{"meta":{"id":"m1","topic":"grpExample","ts":"2026-09-22T12:00:00Z","media":{"items":[],"hasOlder":false,"hasNewer":false,"snapshot":200,"delId":7}}}
```

Nonempty items have this shape; optional fields are omitted when absent:

```json
{"seq":190,"key":2,"type":"IM","data":{"ref":"/v0/file/s/example.png","mime":"image/png","width":640,"height":480},"from":"usrExample","ts":"2026-09-22T12:00:00Z","inline":true,"clientId":"original-own-client-id"}
```

`key` is the original Drafty entity-array index, never a renumbered page index.
Items are ordered by `(seq DESC, key DESC)`. Categories are `visual` (IM, VD),
`audio` (AU), and `files` (EX). The server does not recursively discover entities
in hidden/spoiler fragments; quote/hidden-only references are excluded.

`clientId` is included only when the message's stored sender is the requesting
user and its `x-client-id` header is a bounded string. It is a merge hint, not an
authorization assertion. `inline:true` means the original entity has a `val`;
the grid response never includes that field. A viewer may fetch precisely that
message through stock `get.data` if it needs inline bytes and no usable ref.

At most one exclusive direction cursor or inclusive anchor is accepted:

```json
{"get":{"id":"m2","topic":"grpExample","what":"media","media":{"kind":"visual","before":{"seq":190,"key":2},"limit":24,"snapshot":200}}}
{"get":{"id":"m3","topic":"grpExample","what":"media","media":{"kind":"visual","after":{"seq":90,"key":0},"limit":24,"snapshot":200}}}
{"get":{"id":"m4","topic":"grpExample","what":"media","media":{"kind":"visual","around":{"seq":150,"key":1},"limit":24}}}
```

`before` returns the nearest older items, `after` the nearest newer items; both
are still returned newest first. `around` allocates up to half the page to newer
items, includes the anchor if visible, then fills the remainder with older items.
It adds `anchorFound`. Deleted/missing anchors do not expose their data, and
neighboring visible items may still be returned. `hasOlder`/`hasNewer` describe
visible items outside the returned page, not raw chat-message distance. An empty
directional page uses its request cursor for these flags.

## Consistency and bounds

The first page captures the topic's current sequence ceiling as `snapshot`.
Reuse it for a stable upper boundary while paging; omit it on refresh to include
new media. It is not a historical deletion snapshot: current hard deletions and
the caller's soft deletions are always respected. `delId` is the topic actor's
deletion watermark for that subscription. One repeatable-read SQL transaction
computes the page and both edges. Normal delete events remain the client's cache
invalidation mechanism; a media request changes neither read receipts nor chat
history coverage and emits no ordinary `data` packets.

Output metadata is whitelisted: refs up to 2048 UTF-8 bytes, names 256, MIME
strings 128, explicit previews 4096, and finite nonnegative numeric dimensions,
size and duration. A referenced IM's valid base64 `val` may become `preview`
when no accepted explicit preview exists, capped at 16384 base64 characters.
Inline-only originals, arbitrary objects/headers and hidden fragments are never
copied. Documents above 256 entities or 1024 formats are not atlas candidates;
their ordinary message storage/history is unchanged.

Three partial indexes are built over existing messages on first patched startup
and maintained by PostgreSQL thereafter. There is no client full-history scan,
shadow service or persisted duplicate message projection. Migration is additive
and transactional; back up first and allow an appropriate maintenance window for
index creation. See [SETUP.md](SETUP.md) for deployment instructions.

## Compatibility and fallback

An unextended stock server rejects this unsupported metadata query; the gateway
surfaces a typed protocol error. The client must show atlas unavailable/retry
(or its explicitly partial local metadata cache), not silently download all chat
history. Ordinary chat/auth/upload protocols remain stock-compatible. Deploy
the patched backend before expecting online independent atlas pagination.
