# Protocol Versioning and Migration

Current wire protocol version: `v=1`.

## Rule

- Every client message includes `v`.
- Server responses include `v`.
- If server receives unsupported `v`, connection is rejected with `protocol_version_mismatch`.

## Compatibility policy

- `v=1` clients are supported by `v=1` servers.
- Minor additive fields are allowed within same major version.
- Breaking wire changes require `v=2` rollout.

## Suggested rollout for `v+1`

1. Deploy server that supports both `v` and `v+1` (dual-read/dual-write period).
2. Upgrade clients gradually to `v+1`.
3. Monitor `/metrics` for old-version traffic.
4. Remove old version support only after old client traffic is zero for a full release cycle.

## Storage migration note

Durable room logs are append-only JSONL. If event schema changes:

1. Add reader backward compatibility for old records.
2. Re-compact room files through in-memory canonical representation.
3. Persist rewritten records in new schema.
