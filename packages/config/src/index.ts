import { z } from "zod";

const envSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  PORT: z.coerce.number().int().positive().default(3000),
  HOST: z.string().default("0.0.0.0"),
  DATABASE_URL: z.string().min(1),
  DATABASE_READ_URL: z.string().min(1).optional(),
  REDIS_URL: z.string().min(1).optional(),
  ICD10_API_BASE_URL: z
    .string()
    .url()
    .default("https://clinicaltables.nlm.nih.gov/api/icd10cm/v3/search"),
  AUDIT_TRANSPORT: z.enum(["auto", "direct", "redis"]).default("auto"),
  AUDIT_QUEUE_KEY: z.string().default("medsys:audit:events"),
  AUDIT_WORKER_BLOCK_SECONDS: z.coerce.number().int().positive().default(5),
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
  const parsed = envSchema.safeParse(process.env);
  if (!parsed.success) {
    throw new Error(`Environment validation failed: ${parsed.error.message}`);
  }
  return parsed.data;
};
