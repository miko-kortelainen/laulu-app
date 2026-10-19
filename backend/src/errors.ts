// Only messages authored for users may cross the API boundary.
export class PublicError extends Error {}

export function publicErrorMessage(error: unknown, fallback: string): string {
  if (!(error instanceof PublicError) || error.cause !== undefined) console.error(fallback, error);
  return error instanceof PublicError ? error.message : fallback;
}
