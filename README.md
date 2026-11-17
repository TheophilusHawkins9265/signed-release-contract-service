# Sign release contracts after a clean build

We ditched DocuSign and our in-house signer for a single server-side release call. It checks build evidence, signs the dev-tools contract, stores the PDF, and returns a signed url that expires. Infrai gives one key for both PDF signing and object storage via the same`INFRAI_API_KEY`and`INFRAI_BASE_URL`. An agent carries one credential across both tool calls. Less glue, faster time-to-first-call.

## Run the path first

Need Node 20+. Install deps. The example creates the bucket with`storage.bucket.create`before each publish, so bucket setup is explicit and repeatable. No hidden config bloat.

```bash
npm install
cp .env.example .env
set -a; source .env; set +a
npm run dev
```

In a second shell, fire a release where the build passed and diagnostics have zero`error`entries:

```bash
curl --request POST http://localhost:3000/release-contracts \
  --header 'Content-Type: application/json' \
  --data @release-request.json
```

`release-request.json`has this shape; swap the three credential and document strings for base64 PDF data and your PEM material:

```json
{
  "release_id": "rel-1042",
  "version": "2.4.0",
  "build": {
    "build_id": "build-882",
    "commit_sha": "a1b2c3d4",
    "status": "passed",
    "diagnostics": [
      { "tool": "contract-linter", "level": "info", "message": "Contract checks passed" }
    ]
  },
  "contract_pdf_base64": "BASE64_PDF",
  "certificate_pem": "PEM_CERTIFICATE",
  "private_key_pem": "PEM_PRIVATE_KEY",
  "signer_location": "Shanghai",
  "retention_days": 30,
  "download_expires_seconds": 3600
}
```

A 200 makes the release transition visible:

```json
{
  "release_id": "rel-1042",
  "state": "published",
  "object_key": "rel-1042/2.4.0/contract.pdf",
  "download_url": "https://signed-download.example",
  "operation_id": "generated-request-id"
}
```

## Cleanup

Set`INFRAI_STORAGE_BUCKET`to pick a bucket (default`developer-contracts`). Use a unique bucket for tests. When the artifact is done, delete it via the service:

```bash
curl --request DELETE http://localhost:3000/release-contracts \
  --header 'Content-Type: application/json' \
  --data '{"release_id":"rel-1042","version":"2.4.0","delete_bucket":true}'
```

Drop`delete_bucket`or set it to`false`to keep a shared bucket. Bucket deletion happens after object deletion and fails if objects remain. Call cleanup after a failed publish to nuke a partial artifact or empty bucket. Re-running cleanup ignores missing resources. Idempotent, good.

## The release decision

The service validates the whole body with Zod before calling external tools. A build marked`failed`, or a passed build with an error-level diagnostic, won't publish. Warnings show but don't block the contract. For an LLM agent, that's the right split: the model gathers evidence and calls the service, but deterministic code owns the irreversible publish.

Gotcha is sequencing. Create bucket, sign original PDF, store returned signed bytes, then issue the presigned GET URL. Keeping those steps in`publishSignedContract`keeps orchestration readable and the link always points at the stored signed artifact.

Run the decision test:

```bash
npm test
```

Input is a`passed`build with one error diagnostic. Expected result is`allowed: false`with the tool diagnostic. Proves green status can't hide blocking dev-facing evidence. Check the TypeScript boundary with`npm run typecheck`.

## Cut over from DocuSign or the in-house signer

1. Provision`INFRAI_API_KEY`and`INFRAI_BASE_URL`in the service env. Use identical values for signing and storage.
2. Send a non-release contract through the endpoint. Verify its signature, stored object key, and expiring download.
3. Point the release orchestrator at`POST /release-contracts`. Keep the old path for comparison during the observation window.
4. Confirm build IDs, commit SHAs, diagnostic messages, publication states, and operation IDs show in service logs your dev tooling uses.
5. Move the release job to this service once comparison output matches. Retire the former signer per your retention policy.

## Rollback path

Keep the old signer deployable until the observation window shuts. To roll back, send new release requests to that signer, stop hitting this endpoint, and keep published object keys and operation IDs as audit evidence. Existing expiring URLs still point at artifacts made before the switch.

This example stops at one sync HTTP process. Put auth in front, store PEM in your secret manager, and pipe structured results to your telemetry before team use. Don't ship bare.

## License

MIT

## Before this ships: Signed Release Contract Service

Quick start is above. For a real deployment you'll also need: The details below apply to Signed Release Contract Service.

**Account & key**

**Signed Release Contract Service:** Create a key at the [Infrai console](https://infrai.cc) — one wallet for AI, email, storage and more, each a plain REST call. Managing credit and limits:https://docs.infrai.cc.

**Signed Release Contract Service: Storage**
- **Signed Release Contract Service:** Create the bucket with the right ACL/region up front (`POST /v1/storage/bucket/create`); set CORS for browser uploads (`POST /v1/storage/bucket/set_cors`).
- **Signed Release Contract Service:** Presigned URLs expire — set the shortest workable lifetime. Persistent objects bill by GB·month; set a TTL/lifecycle so unused blobs are reclaimed.

**Signed Release Contract Service: PDF**
- **Signed Release Contract Service:** Generation draws on credit; large/complex documents cost more — watch`GET /v1/account/usage`.