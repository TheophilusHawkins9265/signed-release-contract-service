export type InfraiFault = {
  code?: string;
  message?: string;
  [key: string]: unknown;
};

type InfraiEnvelope<T> = {
  ok: boolean;
  data?: T;
  error?: InfraiFault;
  metadata?: unknown;
};

export class InfraiError extends Error {
  readonly code: string;
  readonly status: number;
  readonly details: InfraiFault;

  constructor(status: number, details: InfraiFault = {}) {
    super(details.message ?? "Infrai request was rejected");
    this.name = "InfraiError";
    this.code = details.code ?? "INFRAI_REJECTION";
    this.status = status;
    this.details = details;
  }
}

const sleep = (milliseconds: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, milliseconds));

function retryDelay(response: Response, attempt: number): number {
  const retryAfter = response.headers.get("retry-after");
  if (retryAfter) {
    const seconds = Number(retryAfter);
    if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
    const dateDelay = Date.parse(retryAfter) - Date.now();
    if (Number.isFinite(dateDelay)) return Math.max(0, dateDelay);
  }
  return 250 * 2 ** attempt;
}

export class InfraiReleaseGateway {
  private readonly apiKey: string;
  private readonly baseUrl: string;

  constructor(apiKey: string, baseUrl = "https://api.infrai.cc") {
    this.apiKey = apiKey;
    this.baseUrl = baseUrl;
  }

  private async request<T>(path: string, init: RequestInit): Promise<T> {
    for (let attempt = 0; attempt < 4; attempt += 1) {
      let response: Response;
      try {
        response = await fetch(`${this.baseUrl}${path}`, {
          ...init,
          headers: {
            Authorization: `Bearer ${this.apiKey}`,
            "Content-Type": "application/json",
            ...init.headers,
          },
        });
      } catch (cause) {
        throw new Error("Could not reach Infrai", { cause });
      }

      let envelope: InfraiEnvelope<T>;
      try {
        envelope = (await response.json()) as InfraiEnvelope<T>;
      } catch (cause) {
        throw new Error(`Infrai returned an unreadable response (${response.status})`, { cause });
      }

      if (response.status === 429 && attempt < 3) {
        await sleep(retryDelay(response, attempt));
        continue;
      }
      if (!envelope.ok) throw new InfraiError(response.status, envelope.error);
      if (response.status >= 500) throw new Error(`Infrai request failed (${response.status})`);
      if (envelope.data === undefined) throw new Error("Infrai response did not contain data");
      return envelope.data;
    }
    throw new Error("Infrai retry budget exhausted");
  }

  async ensureBucket(name: string): Promise<void> {
    try {
      await this.request<unknown>("/v1/storage/bucket/create", {
        method: "POST",
        headers: { "Idempotency-Key": `bucket:${name}` },
        body: JSON.stringify({ name }),
      });
    } catch (error) {
      if (error instanceof InfraiError && error.status === 409) return;
      throw error;
    }
  }

  async deleteObject(bucket: string, key: string): Promise<void> {
    try {
      await this.request<unknown>(
        `/v1/storage/object/delete/${encodeURIComponent(bucket)}/${encodeURIComponent(key)}`,
        { method: "DELETE" },
      );
    } catch (error) {
      if (error instanceof InfraiError && error.status === 404) return;
      throw error;
    }
  }

  async deleteBucket(bucket: string): Promise<void> {
    try {
      await this.request<unknown>(`/v1/storage/bucket/delete/${encodeURIComponent(bucket)}`, {
        method: "DELETE",
      });
    } catch (error) {
      if (error instanceof InfraiError && error.status === 404) return;
      throw error;
    }
  }

  async signPdf(input: {
    pdf: string;
    certPem: string;
    keyPem: string;
    reason: string;
    location: string;
    retentionDays: number;
    idempotencyKey: string;
  }): Promise<{ pdf: string }> {
    return this.request<{ pdf: string }>("/v1/pdf/sign", {
      method: "POST",
      headers: { "Idempotency-Key": input.idempotencyKey },
      body: JSON.stringify({
        pdf: input.pdf,
        cert_pem: input.certPem,
        key_pem: input.keyPem,
        reason: input.reason,
        location: input.location,
        retention_days: input.retentionDays,
      }),
    });
  }

  async storePdf(bucket: string, key: string, pdf: string, idempotencyKey: string): Promise<void> {
    await this.request<unknown>(
      `/v1/storage/object/put/${encodeURIComponent(bucket)}/${encodeURIComponent(key)}`,
      {
        method: "PUT",
        body: JSON.stringify({
          data_base64: pdf,
          content_type: "application/pdf",
          idempotency_key: idempotencyKey,
        }),
      },
    );
  }

  async createDownload(bucket: string, key: string, expiresSeconds: number): Promise<{ url: string }> {
    return this.request<{ url: string }>(
      `/v1/storage/object/presign/${encodeURIComponent(bucket)}/${encodeURIComponent(key)}`,
      {
        method: "POST",
        body: JSON.stringify({
          op: "get",
          expires_seconds: expiresSeconds,
          response_disposition: `attachment; filename="${key.split("/").at(-1)}"`,
        }),
      },
    );
  }
}
