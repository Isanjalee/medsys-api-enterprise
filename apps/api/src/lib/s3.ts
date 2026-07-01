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
  "image/png",
  // Phone camera captures (iPhone HEIC/HEIF, some Android WebP) — accept so uploads
  // from a phone photo don't 415. HEIC may not preview inline but downloads fine.
  "image/heic",
  "image/heif",
  "image/webp",
  "image/gif"
]);

const EXTENSION_CONTENT_TYPES: Record<string, string> = {
  pdf: "application/pdf",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  png: "image/png",
  heic: "image/heic",
  heif: "image/heif",
  webp: "image/webp",
  gif: "image/gif"
};

// Phones sometimes send an empty or generic mime type (e.g. application/octet-stream)
// for a camera capture. Fall back to the file extension so the upload still works and
// we store a sensible content type for inline viewing later. Returns null if we can't
// confidently classify it as an allowed document.
export const resolveDocumentContentType = (mimetype: string | undefined, fileName: string): string | null => {
  const mime = (mimetype ?? "").toLowerCase().split(";")[0].trim();
  if (ALLOWED_DOCUMENT_TYPES.has(mime)) {
    return mime;
  }
  const ext = fileName.toLowerCase().split(".").pop() ?? "";
  const byExt = EXTENSION_CONTENT_TYPES[ext];
  // Only trust the extension when the mime type was missing/generic, not when the phone
  // sent a real (but disallowed) type.
  const genericMime = !mime || mime === "application/octet-stream" || mime === "binary/octet-stream";
  return byExt && genericMime ? byExt : null;
};

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
