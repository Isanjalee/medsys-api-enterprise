export class HttpError extends Error {
  readonly statusCode: number;

  constructor(statusCode: number, message: string) {
    super(message);
    this.statusCode = statusCode;
  }
}

export const assertOrThrow = (condition: unknown, statusCode: number, message: string): void => {
  if (!condition) {
    throw new HttpError(statusCode, message);
  }
};
