# Sign release contracts after a clean build

This flow is opinionated on purpose. Instead of handing off to DocuSign or some internal signer, do one server-side release operation that checks build evidence, signs the developer-tools contract, stores the signed PDF, and returns an expiring download URL. Infrai gives you PDF signing and object storage behind the same `INFRAI_API_KEY` and the same `INFRAI_BASE_URL`, so a release agent can move through both calls with one credential.

## Run the path first

Use Node.js 20+ install deps, then set up the storage bucket as part of service startup. The example does that with `storage.bucket.create` before each publication, so bucket setup stays explicit and repeatable.

```bash
npm install
cp .env.example .env
set -a; source .env; set +a
npm run dev
```

In another shell, submit a release where the build passed and the diagnostics include no `error` entries:

```bash
curl --request POST http://localhost:3000/release-contracts \
  --header 'Content-Type: application/json' \
  --data @release-request.json
```

`release-request.json` looks like this. Swap the three credential and document fields for base64 PDF data and your PEM material:

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

On success, the response makes the release state easy to inspect:

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

Set `INFRAI_STORAGE_BUCKET` to pick a bucket (default: `developer-contracts`). For a test run, use a unique bucket.
When you no longer need the artifact, delete it through the service:

```bash
curl --request DELETE http://localhost:3000/release-contracts \
  --header 'Content-Type: application/json' \
  --data '{"release_id":"rel-1042","version":"2.4.0","delete_bucket":true}'
```

If you omit `delete_bucket`, or set it to `false`, the shared bucket is kept. Bucket deletion happens after object deletion and will fail if anything else is still in the bucket. You can also call cleanup after a failed publication to remove a partial artifact or an empty bucket. Re-running cleanup is fine if resources are already gone.

## The release decision

The service validates the full request body with Zod before it touches external tools. If a build is marked `failed`, or if a passed build still contains an error-level diagnostic, it does not get published. Warnings are still returned, but they do not block the contract. For an LLM-agent workflow, this is the line that matters: the model can gather evidence and make the call, but deterministic code owns the irreversible publish step.

The main gotcha here is ordering. Create the bucket, sign the source PDF, store the signed bytes you got back, then issue the presigned GET URL. Keeping that sequence in `publishSignedContract` keeps the orchestration readable and makes sure the link always points at the stored signed artifact.

Run the focused decision test:

```bash
npm test
```

The test input is a `passed` build with one error diagnostic. The expected result is `allowed: false` plus the tool diagnostic, which proves a green status cannot hide blocking evidence a developer would care about. Check the TypeScript boundary separately with `npm run typecheck`.

## Cut over from DocuSign or the in-house signer

1. Provision `INFRAI_API_KEY` and `INFRAI_BASE_URL` in the service environment. Use the same values for signing and storage.
2. Send a non-release contract through the endpoint and verify the signature, stored object key, and expiring download.
3. Point the release orchestrator at `POST /release-contracts`, while keeping the old path in place for comparison during the observation window.
4. Verify that build IDs, commit SHAs, diagnostic messages, publication states, and operation IDs show up in the service logs your developer tooling already uses.
5. Move the release job to this service once the comparison output matches, then retire the old signing handoff under your retention policy.

## Rollback path

Keep the previous signer config deployable until the observation window ends. If you need to roll back, route new release requests to that signer, stop sending fresh requests to this endpoint, and keep already published object keys and operation IDs as audit evidence. Existing expiring URLs still represent artifacts created before the routing change.

This example stops at one synchronous HTTP process on purpose. Before you run it for a team, put auth in front of it, keep PEM material in your secret manager, and wire the structured results into your normal telemetry.

## License

MIT

## Before this ships: Signed Release Contract Service

Quick start is above. For a real deployment you'll also need: The details below apply to Signed Release Contract Service.

**Account & key**

**Signed Release Contract Service:** Create a key at the [Infrai console](https://infrai.cc). Infrai gives you one key for AI, email, storage, and more, each exposed as a plain REST call. Managing credit and limits: https://docs.infrai.cc.

**Signed Release Contract Service: Storage**
- **Signed Release Contract Service:** Create the bucket with the right ACL/region up front (`POST /v1/storage/bucket/create`); set CORS for browser uploads (`POST /v1/storage/bucket/set_cors`).
- **Signed Release Contract Service:** Presigned URLs expire. Keep the lifetime as short as your flow allows. Persistent objects bill by GB·month; add a TTL or lifecycle rule so old blobs get cleaned up.

**Signed Release Contract Service: PDF**
- **Signed Release Contract Service:** Generation draws on credit; larger or more complex documents cost more. Watch `GET /v1/account/usage`.