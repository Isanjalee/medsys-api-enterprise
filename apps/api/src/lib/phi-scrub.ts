const REDACTED = "[REDACTED]";

const SENSITIVE_KEYS = new Set([
  "authorization",
  "password",
  "token",
  "accesstoken",
  "refreshtoken",
  "passwordhash",
  "nic",
  "fullname",
  "firstname",
  "lastname",
  "name",
  "phone",
  "mobile",
  "address",
  "bloodgroup",
  "dob",
  "email",
  "notes",
  "payload"
]);

const MAX_DEPTH = 5;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const looksSensitiveKey = (key: string): boolean => SENSITIVE_KEYS.has(key.replace(/[^a-z]/gi, "").toLowerCase());

export const scrubPhi = (value: unknown, depth = 0): unknown => {
  if (depth > MAX_DEPTH) {
    return "[TRUNCATED]";
  }

  if (value === null || value === undefined) {
    return value;
  }

  if (Array.isArray(value)) {
    return value.map((item) => scrubPhi(item, depth + 1));
  }

  if (isRecord(value)) {
    return Object.fromEntries(
      Object.entries(value).map(([key, nestedValue]) => [
        key,
        looksSensitiveKey(key) ? REDACTED : scrubPhi(nestedValue, depth + 1)
      ])
    );
  }

  return value;
};

export const createSafeRequestLog = (request: {
  id: string;
  method: string;
  url: string;
  ip?: string;
  actor?: { userId: number; role: string; organizationId: string };
  query?: unknown;
  body?: unknown;
}) => ({
  requestId: request.id,
  method: request.method,
  url: request.url,
  ip: request.ip ?? null,
  actor: request.actor
    ? {
        userId: request.actor.userId,
        role: request.actor.role,
        organizationId: request.actor.organizationId
      }
    : null,
  query: scrubPhi(request.query),
  body: scrubPhi(request.body)
});

export const createSafeErrorLog = (error: unknown) => {
  if (!(error instanceof Error)) {
    return {
      type: "UnknownError",
      message: JSON.stringify(scrubPhi(error)),
      stack: ""
    };
  }

  return {
    type: error.name,
    message: error.message,
    stack: error.stack ?? ""
  };
};

export const scrubSentryEvent = <T extends Record<string, unknown>>(event: T): T =>
  scrubPhi(event) as T;
