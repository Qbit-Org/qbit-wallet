/**
 * The text a page shows for a failed wallet call: the rejection's `message`
 * when it is a non-empty string, else the rejection itself when it is a
 * non-empty string, else `fallback` (the page's unknown_error). A rejection
 * from the background crosses the UI port as a plain `{ code?, message?,
 * data? }` object, not an Error, so neither `instanceof Error` nor String()
 * can present it ("[object Object]").
 */
export const walletErrorMessage = (error: unknown, fallback: string): string => {
  if (typeof error === 'string' && error) return error
  const message = (error as { message?: unknown } | null | undefined)?.message
  return typeof message === 'string' && message ? message : fallback
}
