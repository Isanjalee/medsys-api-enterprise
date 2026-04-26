import type { ZodIssue, ZodType } from "zod";
import { ZodError } from "zod";

export class HttpError extends Error {
  readonly statusCode: number;
  readonly code: string;
  readonly severity: "warning" | "error";
  readonly userMessage: string;
  readonly details: Record<string, unknown> | null;

  constructor(
    statusCode: number,
    message: string,
    options?: {
      code?: string;
      severity?: "warning" | "error";
      userMessage?: string;
      details?: Record<string, unknown> | null;
    }
  ) {
    super(message);
    this.statusCode = statusCode;
    this.code = options?.code ?? "HTTP_ERROR";
    this.severity = options?.severity ?? (statusCode >= 500 ? "error" : "warning");
    this.userMessage = options?.userMessage ?? message;
    this.details = options?.details ?? null;
  }
}

export type ValidationIssueCode =
  | "REQUIRED"
  | "UNKNOWN_FIELD"
  | "INVALID_TYPE"
  | "INVALID_VALUE"
  | "INVALID_FORMAT"
  | "OUT_OF_RANGE"
  | "CUSTOM_RULE"
  | (string & {});

export type ValidationIssue = {
  field: string;
  message: string;
  code: ValidationIssueCode;
};

export class ValidationError extends HttpError {
  readonly issues: ValidationIssue[];

  constructor(issues: Array<Omit<ValidationIssue, "code"> & { code?: ValidationIssueCode }>) {
    const normalizedIssues = normalizeValidationIssues(issues);
    super(400, "Validation failed.", {
      code: "VALIDATION_ERROR",
      severity: "warning",
      userMessage: "Please check the highlighted fields and try again.",
      details: { issues: normalizedIssues }
    });
    this.issues = normalizedIssues;
  }
}

const inferValidationIssueCode = (issue: { field: string; message: string }): ValidationIssueCode => {
  const normalizedMessage = issue.message.trim().toLowerCase();

  if (normalizedMessage === "is required." || normalizedMessage.includes(" is required")) {
    return "REQUIRED";
  }
  if (normalizedMessage === "unknown field.") {
    return "UNKNOWN_FIELD";
  }
  if (normalizedMessage.includes("invalid") && normalizedMessage.includes("format")) {
    return "INVALID_FORMAT";
  }
  if (
    normalizedMessage.includes("must contain at most") ||
    normalizedMessage.includes("must contain at least") ||
    normalizedMessage.includes("must be less than") ||
    normalizedMessage.includes("must be greater than") ||
    normalizedMessage.includes("must be on or before") ||
    normalizedMessage.includes("cannot be in the future")
  ) {
    return "OUT_OF_RANGE";
  }
  if (
    normalizedMessage.includes("must be one of") ||
    normalizedMessage.includes("must be a valid enum value") ||
    normalizedMessage.includes("must be assigned")
  ) {
    return "INVALID_VALUE";
  }
  if (normalizedMessage.includes("must be")) {
    return "INVALID_TYPE";
  }
  if (issue.field === "body") {
    return "INVALID_TYPE";
  }

  return "CUSTOM_RULE";
};

const formatZodIssueMessage = (issue: ZodIssue): string => {
  if (issue.code === "invalid_type" && issue.path.length === 0 && issue.expected === "object") {
    return "Must be a JSON object.";
  }
  if (issue.code === "invalid_type" && "received" in issue && issue.received === "undefined") {
    return "Is required.";
  }
  return issue.message.endsWith(".") ? issue.message : `${issue.message}.`;
};

const zodIssueToValidationCode = (issue: ZodIssue): ValidationIssueCode => {
  if (issue.code === "unrecognized_keys") {
    return "UNKNOWN_FIELD";
  }
  if (issue.code === "invalid_type") {
    if ("received" in issue && issue.received === "undefined") {
      return "REQUIRED";
    }
    return "INVALID_TYPE";
  }
  if (issue.code === "invalid_string" || issue.code === "invalid_date") {
    return "INVALID_FORMAT";
  }
  if (issue.code === "invalid_enum_value" || issue.code === "not_multiple_of" || issue.code === "invalid_literal") {
    return "INVALID_VALUE";
  }
  if (issue.code === "too_small" || issue.code === "too_big") {
    return "OUT_OF_RANGE";
  }
  return "CUSTOM_RULE";
};

const normalizeValidationIssues = (
  issues: Array<Omit<ValidationIssue, "code"> & { code?: ValidationIssueCode }>
): ValidationIssue[] =>
  issues.map((issue) => ({
    field: issue.field,
    message: issue.message,
    code: issue.code ?? inferValidationIssueCode(issue)
  }));

const issuesFromZodIssue = (issue: ZodIssue): ValidationIssue[] => {
  if (issue.code === "unrecognized_keys") {
    return issue.keys.map((key) => ({
      field: key,
      message: "Unknown field.",
      code: "UNKNOWN_FIELD"
    }));
  }

  const message = formatZodIssueMessage(issue);
  const field = issue.path.length > 0 ? issue.path.join(".") : "body";

  return [
    {
      field,
      message,
      code: zodIssueToValidationCode(issue)
    }
  ];
};

export const validationIssuesFromZodError = (error: ZodError): ValidationIssue[] =>
  error.issues.flatMap(issuesFromZodIssue);

export const validationError = (
  issues: Array<Omit<ValidationIssue, "code"> & { code?: ValidationIssueCode }>
): ValidationError => new ValidationError(issues);

export const parseOrThrowValidation = <T>(schema: ZodType<T>, input: unknown): T => {
  const result = schema.safeParse(input);
  if (!result.success) {
    throw validationError(validationIssuesFromZodError(result.error));
  }
  return result.data;
};

export const assertOrThrow = (condition: unknown, statusCode: number, message: string): void => {
  if (!condition) {
    throw new HttpError(statusCode, message, {
      code:
        statusCode === 401
          ? "UNAUTHORIZED"
          : statusCode === 403
            ? "FORBIDDEN"
            : statusCode === 404
              ? "NOT_FOUND"
              : statusCode === 409
                ? "CONFLICT"
                : statusCode === 429
                  ? "RATE_LIMITED"
                  : statusCode === 503
                    ? "SERVICE_UNAVAILABLE"
                    : "HTTP_ERROR",
      severity: statusCode >= 500 ? "error" : "warning"
    });
  }
};
