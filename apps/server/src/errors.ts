export class AppError extends Error {
  public readonly status: 400 | 401 | 403 | 404 | 409 | 413 | 422 | 429 | 500 | 502 | 503;
  constructor(
    message: string,
    status: 400 | 401 | 403 | 404 | 409 | 413 | 422 | 429 | 500 | 502 | 503 = 400,
  ) {
    super(message);
    this.status = status;
    this.name = "AppError";
  }
}
