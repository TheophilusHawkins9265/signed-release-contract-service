import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { InfraiError, InfraiReleaseGateway } from "./infrai_release_gateway.js";

const buildEventSchema = z.object({
  build_id: z.string().min(1),
  commit_sha: z.string().regex(/^[0-9a-f]{7,40}$/i),
  status: z.enum(["passed", "failed"]),
  diagnostics: z.array(z.object({
    tool: z.string().min(1),
    level: z.enum(["info", "warning", "error"]),
    message: z.string().min(1),
  })).default([]),
});

export const releaseContractSchema = z.object({
  release_id: z.string().min(1).max(100),
  version: z.string().min(1).max(100),
  build: buildEventSchema,
  contract_pdf_base64: z.string().min(1),
  certificate_pem: z.string().min(1),
  private_key_pem: z.string().min(1),
  signer_location: z.string().min(1),
  retention_days: z.number().int().positive().max(3650).default(30),
  download_expires_seconds: z.number().int().positive().max(604800).default(3600),
});

export type ReleaseContract = z.infer<typeof releaseContractSchema>;

export function decideRelease(input: ReleaseContract): { allowed: true } | { allowed: false; diagnostic: string } {
  if (input.build.status !== "passed") {
    return { allowed: false, diagnostic: `Build ${input.build.build_id} has not passed` };
  }
  const blocking = input.build.diagnostics.find((item) => item.level === "error");
  if (blocking) return { allowed: false, diagnostic: `${blocking.tool}: ${blocking.message}` };
  return { allowed: true };
}

export async function publishSignedContract(
  input: ReleaseContract,
  gateway: InfraiReleaseGateway,
  bucket = "developer-contracts",
): Promise<{ release_id: string; state: "published"; object_key: string; download_url: string }> {
  const decision = decideRelease(input);
  if (decision.allowed === false) throw new ReleaseBlockedError(decision.diagnostic);

  const objectKey = `${input.release_id}/${input.version}/contract.pdf`;
  await gateway.ensureBucket(bucket);
  const signed = await gateway.signPdf({
    pdf: input.contract_pdf_base64,
    certPem: input.certificate_pem,
    keyPem: input.private_key_pem,
    reason: `Approve developer-tools release ${input.version}`,
    location: input.signer_location,
    retentionDays: input.retention_days,
    idempotencyKey: `sign-contract:${input.release_id}:${input.version}`,
  });
  await gateway.storePdf(bucket, objectKey, signed.pdf, `release-contract:${input.release_id}:${input.version}`);
  const download = await gateway.createDownload(bucket, objectKey, input.download_expires_seconds);
  return { release_id: input.release_id, state: "published", object_key: objectKey, download_url: download.url };
}

class ReleaseBlockedError extends Error {}

function sendJson(response: import("node:http").ServerResponse, status: number, value: unknown): void {
  response.writeHead(status, { "Content-Type": "application/json" });
  response.end(JSON.stringify(value));
}

const cleanupSchema = releaseContractSchema.pick({ release_id: true, version: true }).extend({
  delete_bucket: z.boolean().default(false),
});

export function createReleaseServer(gateway: InfraiReleaseGateway, bucket = "developer-contracts") {
  return createServer(async (request, response) => {
  if (!["POST", "DELETE"].includes(request.method ?? "") || request.url !== "/release-contracts") {
    sendJson(response, 404, { error: "Route not found" });
    return;
  }

  try {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const body: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    if (request.method === "DELETE") {
      const cleanup = cleanupSchema.safeParse(body);
      if (!cleanup.success) {
        sendJson(response, 400, { error: "Invalid request", diagnostics: cleanup.error.issues });
        return;
      }
      const key = `${cleanup.data.release_id}/${cleanup.data.version}/contract.pdf`;
      await gateway.deleteObject(bucket, key);
      if (cleanup.data.delete_bucket) await gateway.deleteBucket(bucket);
      sendJson(response, 200, { state: "deleted", object_key: key, bucket_deleted: cleanup.data.delete_bucket });
      return;
    }
    const parsed = releaseContractSchema.safeParse(body);
    if (!parsed.success) {
      sendJson(response, 400, { error: "Invalid request", diagnostics: parsed.error.issues });
      return;
    }
    const result = await publishSignedContract(parsed.data, gateway, bucket);
    sendJson(response, 201, { ...result, operation_id: randomUUID() });
  } catch (error) {
    if (error instanceof ReleaseBlockedError) sendJson(response, 409, { error: error.message });
    else if (error instanceof InfraiError) sendJson(response, error.status >= 400 && error.status < 500 ? error.status : 502, { error: error.code, message: error.message });
    else if (error instanceof SyntaxError) sendJson(response, 400, { error: "Request body must be JSON" });
    else sendJson(response, 502, { error: "Release operation could not be completed" });
  }
  });
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const apiKey = process.env.INFRAI_API_KEY;
  if (!apiKey) throw new Error("Set INFRAI_API_KEY before starting the service");
  const gateway = new InfraiReleaseGateway(apiKey, process.env.INFRAI_BASE_URL);
  const port = Number(process.env.PORT ?? 3000);
  createReleaseServer(gateway, process.env.INFRAI_STORAGE_BUCKET).listen(port, () => {
    console.log(`Release contract service listening on http://localhost:${port}`);
  });
}
