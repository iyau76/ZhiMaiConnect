export type ApiErrorCode =
  | "INVALID_CONTENT_TYPE"
  | "INVALID_JSON"
  | "INVALID_REQUEST"
  | "PAYLOAD_TOO_LARGE"
  | "RATE_LIMITED"
  | "SESSION_REQUIRED"
  | "CUSTOM_HOST_DENIED"
  | "UPSTREAM_REJECTED"
  | "UPSTREAM_TIMEOUT"
  | "UPSTREAM_UNAVAILABLE"
  | "UPSTREAM_INVALID_RESPONSE"
  | "MODEL_OUTPUT_TRUNCATED"
  | "SERVER_MISCONFIGURED"
  | "INTERNAL_ERROR";

export class SafeApiError extends Error {
  readonly status: number;
  readonly code: ApiErrorCode;
  readonly retryAfterSeconds?: number;

  constructor(status: number, code: ApiErrorCode, message: string, retryAfterSeconds?: number) {
    super(message);
    this.name = "SafeApiError";
    this.status = status;
    this.code = code;
    this.retryAfterSeconds = retryAfterSeconds;
  }
}
