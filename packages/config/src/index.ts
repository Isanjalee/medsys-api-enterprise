import { existsSync, readFileSync } from "node:fs";
import { dirname, join, parse } from "node:path";
import { z } from "zod";

const findUp = (fileName: string, startDir: string): string | null => {
  let currentDir = startDir;
  const { root } = parse(startDir);

  while (true) {
    const candidate = join(currentDir, fileName);
    if (existsSync(candidate)) {
      return candidate;
    }

    if (currentDir === root) {
      return null;
    }

    currentDir = dirname(currentDir);
  }
};

const loadDotEnv = (): void => {
  const envPath = findUp(".env", process.cwd());
  if (!envPath) {
    return;
  }

  const envContents = readFileSync(envPath, "utf8");

  for (const line of envContents.split(/\r?\n/)) {
    const trimmedLine = line.trim();
    if (!trimmedLine || trimmedLine.startsWith("#")) {
      continue;
    }

    const separatorIndex = trimmedLine.indexOf("=");
    if (separatorIndex <= 0) {
      continue;
    }

    const key = trimmedLine.slice(0, separatorIndex).trim();
    let value = trimmedLine.slice(separatorIndex + 1).trim();

    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }

    if (!(key in process.env)) {
      process.env[key] = value.replace(/\\n/g, "\n");
    }
  }
};

const envSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  PORT: z.coerce.number().int().positive().default(3000),
  HOST: z.string().default("0.0.0.0"),
  DATABASE_URL: z.string().min(1),
  DATABASE_READ_URL: z.string().min(1).optional(),
  REDIS_URL: z.string().min(1).optional(),
  OPENSEARCH_URL: z.string().url().optional(),
  OPENSEARCH_PATIENT_INDEX: z.string().default("medsys_patients"),
  OPENSEARCH_DIAGNOSIS_INDEX: z.string().default("medsys_diagnoses"),
  ICD10_API_BASE_URL: z
    .string()
    .url()
    .default("https://clinicaltables.nlm.nih.gov/api/icd10cm/v3/search"),
  AUDIT_TRANSPORT: z.enum(["auto", "direct", "redis"]).default("auto"),
  AUDIT_QUEUE_KEY: z.string().default("medsys:audit:events"),
  AUDIT_RETRY_QUEUE_KEY: z.string().optional(),
  AUDIT_DLQ_KEY: z.string().optional(),
  AUDIT_MAX_RETRIES: z.coerce.number().int().positive().default(3),
  AUDIT_RETRY_BASE_DELAY_MS: z.coerce.number().int().positive().default(250),
  AUDIT_WORKER_BLOCK_SECONDS: z.coerce.number().int().positive().default(5),
  APPOINTMENT_QUEUE_CACHE_TTL_SECONDS: z.coerce.number().int().positive().default(15),
  PATIENT_PROFILE_CACHE_TTL_SECONDS: z.coerce.number().int().positive().default(30),
  SENTRY_DSN: z.string().url().optional(),
  AUTH_LOGIN_MAX_ATTEMPTS: z.coerce.number().int().positive().default(5),
  AUTH_LOGIN_LOCKOUT_SECONDS: z.coerce.number().int().positive().default(300),
  SECURITY_SENSITIVE_WINDOW_SECONDS: z.coerce.number().int().positive().default(3600),
  JWT_ACCESS_PUBLIC_KEY: z.string().min(1),
  JWT_ACCESS_PRIVATE_KEY: z.string().min(1),
  JWT_REFRESH_PUBLIC_KEY: z.string().min(1),
  JWT_REFRESH_PRIVATE_KEY: z.string().min(1),
  ACCESS_TOKEN_TTL_SECONDS: z.coerce.number().int().positive().default(900),
  REFRESH_TOKEN_TTL_SECONDS: z.coerce.number().int().positive().default(604800),
  REQUEST_ID_HEADER: z.string().default("x-request-id"),
  ORGANIZATION_ID: z.string().uuid()
});

export type AppEnv = z.infer<typeof envSchema>;

export const loadEnv = (): AppEnv => {
  loadDotEnv();
  const parsed = envSchema.safeParse(process.env);
  if (!parsed.success) {
    throw new Error(`Environment validation failed: ${parsed.error.message}`);
  }
  return parsed.data;
};
