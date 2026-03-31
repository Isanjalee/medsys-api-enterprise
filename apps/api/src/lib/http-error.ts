import type { ZodIssue, ZodType } from "zod";
import { ZodError } from "zod";

export class HttpError extends Error {
  readonly statusCode: number;
  readonly code: string;
  readonly severity: "warning" | "error";
  readonly userMessage: string;

  constructor(
    statusCode: number,
    message: string,
    options?: {
      code?: string;
      severity?: "warning" | "error";
      userMessage?: string;
    }
  ) {
    super(message);
    this.statusCode = statusCode;
    this.code = options?.code ?? "HTTP_ERROR";
    this.severity = options?.severity ?? (statusCode >= 500 ? "error" : "warning");
    this.userMessage = options?.userMessage ?? message;
  }
}

export type ValidationIssue = {
  field: string;
  message: string;
};

export class ValidationError extends HttpError {
  readonly issues: ValidationIssue[];

  constructor(issues: ValidationIssue[]) {
    super(400, "Validation failed.", {
      code: "VALIDATION_ERROR",
      severity: "warning",
      userMessage: "Please check the highlighted fields and try again."
    });
    this.issues = issues;
  }
}

const formatZodIssueMessage = (issue: ZodIssue): string => {
  if (issue.code === "invalid_type" && issue.path.length === 0 && issue.expected === "object") {
    return "Must be a JSON object.";
  }
  if (issue.code === "invalid_type" && "received" in issue && issue.received === "undefined") {
    return "Is required.";
  }
  return issue.message.endsWith(".") ? issue.message : `${issue.message}.`;
};

const issuesFromZodIssue = (issue: ZodIssue): ValidationIssue[] => {
  if (issue.code === "unrecognized_keys") {
    return issue.keys.map((key) => ({
      field: key,
      message: "Unknown field."
    }));
  }

  return [
    {
      field: issue.path.length > 0 ? issue.path.join(".") : "body",
      message: formatZodIssueMessage(issue)
    }
  ];
};

export const validationIssuesFromZodError = (error: ZodError): ValidationIssue[] =>
  error.issues.flatMap(issuesFromZodIssue);

export const validationError = (issues: ValidationIssue[]): ValidationError => new ValidationError(issues);

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
