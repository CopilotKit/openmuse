export class AppError extends Error {
  constructor(
    message: string,
    public readonly status: 400 | 401 | 403 | 404 | 409 | 413 | 422 | 429 | 500 | 502 | 503 = 400,
    /**
     * Extra machine-readable context merged into the JSON body, e.g. the legal
     * next board transitions on a rejected move. Omitted entirely when absent so
     * existing error shapes are unchanged.
     */
    public readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "AppError";
  }
}
