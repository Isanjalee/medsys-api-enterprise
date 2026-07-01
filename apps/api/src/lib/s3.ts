// Thin wrapper over S3 for patient documents. On the prod EC2 box credentials come
// from the instance role, so we only need a region + bucket. If the bucket isn't
// configured (e.g. local dev) the document feature is disabled and callers 503.
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

export const documentsEnabled = (env: AppEnv): boolean => Boolean(env.S3_DOCUMENTS_BUCKET);

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

export const putDocument = async (
  env: AppEnv,
  key: string,
  body: Buffer,
  contentType: string
): Promise<void> => {
  await client(env).send(
    new PutObjectCommand({
      Bucket: env.S3_DOCUMENTS_BUCKET,
      Key: key,
      Body: body,
      ContentType: contentType,
      ServerSideEncryption: "AES256"
    })
  );
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
