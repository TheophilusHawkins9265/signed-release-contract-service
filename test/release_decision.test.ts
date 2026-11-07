import assert from "node:assert/strict";
import test from "node:test";
import { decideRelease, releaseContractSchema } from "../src/release_contract_service.js";

test("an error diagnostic blocks an otherwise passed build", () => {
  const input = releaseContractSchema.parse({
    release_id: "rel-1042",
    version: "2.4.0",
    build: {
      build_id: "build-882",
      commit_sha: "a1b2c3d4",
      status: "passed",
      diagnostics: [{ tool: "contract-linter", level: "error", message: "Required clause is absent" }],
    },
    contract_pdf_base64: "JVBERi0xLjQK",
    certificate_pem: "certificate",
    private_key_pem: "private-key",
    signer_location: "Shanghai",
  });

  assert.deepEqual(decideRelease(input), {
    allowed: false,
    diagnostic: "contract-linter: Required clause is absent",
  });
});

test("cleanup removes the release object before the explicitly requested bucket", async () => {
  const { createReleaseServer } = await import("../src/release_contract_service.js");
  const { InfraiReleaseGateway } = await import("../src/infrai_release_gateway.js");
  const calls: string[] = [];
  class Gateway extends InfraiReleaseGateway {
    override async deleteObject(bucket: string, key: string) {
      calls.push(`object:${bucket}:${key}`);
    }
    override async deleteBucket(bucket: string) {
      calls.push(`bucket:${bucket}`);
    }
  }
  const server = createReleaseServer(new Gateway("test"), "test-contracts");
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = server.address() as import("node:net").AddressInfo;
    const cleanup = (deleteBucket: boolean) => fetch(`http://127.0.0.1:${address.port}/release-contracts`, {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ release_id: "release", version: "1", delete_bucket: deleteBucket }),
    });
    assert.equal((await cleanup(false)).status, 200);
    assert.deepEqual(calls, ["object:test-contracts:release/1/contract.pdf"]);
    calls.length = 0;
    assert.equal((await cleanup(true)).status, 200);
    assert.deepEqual(calls, ["object:test-contracts:release/1/contract.pdf", "bucket:test-contracts"]);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});
