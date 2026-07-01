// Document storage. In production the prod EC2 box has an instance role, so we only
// need a region + bucket and objects live in S3. When no bucket is configured
// (e.g. local dev) we transparently fall back to the local filesystem so the whole
// documents feature works without any cloud dependency. Callers use the same API in
// both modes; `documentsEnabled` is therefore always true.
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { GetObjectCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import type { AppEnv } from "@medsys/config";

let cachedClient: S3Client | null = null;

const client = (env: AppEnv): S3Client => {
  if (!cachedClient) {
    cachedClient = new S3Client({ region: env.AWS_REGION });
  }
  return cachedClient;
};

const useS3 = (env: AppEnv): boolean => Boolean(env.S3_DOCUMENTS_BUCKET);

// Document storage is always available: S3 when configured, local filesystem otherwise.
export const documentsEnabled = (_env: AppEnv): boolean => true;

// Whether download URLs are presigned S3 links (true) or must be streamed through the
// backend `/:id/raw` route (false, local filesystem mode).
export const supportsPresignedUrls = (env: AppEnv): boolean => useS3(env);

export const ALLOWED_DOCUMENT_TYPES = new Set([
  "application/pdf",
  "image/jpeg",
  "image/png"
]);

export const buildDocumentKey = (
  organizationId: string,
  patientId: number,
  uuid: string,
  fileName: string
): string => {
  const safeName = fileName.replace(/[^A-Za-z0-9._-]/g, "_").slice(-120);
  return `org/${organizationId}/patient/${patientId}/${uuid}-${safeName}`;
};

// Resolve a storage key to a safe absolute path under the local documents dir.
// The key is hashed into the filename so path separators in the key can never
// escape the base directory.
const localPathForKey = (env: AppEnv, key: string): string => {
  const base = resolve(process.cwd(), env.DOCUMENTS_LOCAL_DIR);
  const digest = createHash("sha256").update(key).digest("hex");
  return join(base, digest.slice(0, 2), `${digest}.bin`);
};

export const putDocument = async (
  env: AppEnv,
  key: string,
  body: Buffer,
  contentType: string
): Promise<void> => {
  if (useS3(env)) {
    await client(env).send(
      new PutObjectCommand({
        Bucket: env.S3_DOCUMENTS_BUCKET,
        Key: key,
        Body: body,
        ContentType: contentType,
        ServerSideEncryption: "AES256"
      })
    );
    return;
  }

  const path = localPathForKey(env, key);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, body);
};

// Read the raw bytes back for streaming through the backend. Works in both modes.
export const getDocument = async (env: AppEnv, key: string): Promise<Buffer> => {
  if (useS3(env)) {
    const result = await client(env).send(
      new GetObjectCommand({ Bucket: env.S3_DOCUMENTS_BUCKET, Key: key })
    );
    const bytes = await result.Body!.transformToByteArray();
    return Buffer.from(bytes);
  }

  return readFile(localPathForKey(env, key));
};

export const presignDownload = async (
  env: AppEnv,
  key: string,
  fileName: string,
  expiresInSeconds = 300
): Promise<string> =>
  getSignedUrl(
    client(env),
    new GetObjectCommand({
      Bucket: env.S3_DOCUMENTS_BUCKET,
      Key: key,
      ResponseContentDisposition: `inline; filename="${fileName.replace(/"/g, "")}"`
    }),
    { expiresIn: expiresInSeconds }
  );
