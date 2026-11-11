/** Error the Drive HTTP layer can show to a signed-in person. Never put key material in message. */
export class DriveError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = "DriveError";
    this.status = status;
    this.code = code;
  }
}
