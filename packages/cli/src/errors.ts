/**
 * Typed error codes for agent-consumable CLI output (17 §13).
 * Every command's `--json` failure envelope carries one of these codes so an
 * agent can branch on `error.code` instead of parsing prose.
 */
export const ERR = {
  /** Generic/uncategorized failure. */
  INTERNAL: "E_INTERNAL",
  /** Project dir missing, no composition root, or lint errors block the op. */
  INVALID_PROJECT: "E_INVALID_PROJECT",
  /** Composition failed lint/browser check. */
  CHECK_FAILED: "E_CHECK_FAILED",
  /** Referenced file/asset does not exist. */
  FILE_NOT_FOUND: "E_FILE_NOT_FOUND",
  /** Required external binary (ffmpeg, whisper-cli, chrome) is missing. */
  BINARY_MISSING: "E_BINARY_MISSING",
  /** Model file absent/corrupt or failed checksum. */
  MODEL_ERROR: "E_MODEL_ERROR",
  /** External service/provider failed. */
  PROVIDER_ERROR: "E_PROVIDER_ERROR",
  /** Render pipeline failure. */
  RENDER_FAILED: "E_RENDER_FAILED",
  /** Unknown block/component in registry. */
  BLOCK_NOT_FOUND: "E_BLOCK_NOT_FOUND",
  /** User/declined confirmation in unattended mode. */
  NEEDS_CONFIRMATION: "E_NEEDS_CONFIRMATION",
  /** Bad flag/argument value or combination. */
  INVALID_ARGS: "E_INVALID_ARGS",
} as const;

export type ErrCode = (typeof ERR)[keyof typeof ERR];

export class CliError extends Error {
  constructor(
    public code: ErrCode,
    message: string,
    public hint?: string,
  ) {
    super(message);
  }
}

export interface JsonResult<T> {
  ok: boolean;
  data?: T;
  error?: { code: ErrCode; message: string; hint?: string };
}

/** Emit a command result as the standard JSON envelope. */
export function jsonOut<T>(data: T): void {
  const out: JsonResult<T> = { ok: true, data };
  process.stdout.write(`${JSON.stringify(out)}\n`);
}

export function jsonErr(e: unknown): void {
  const err: JsonResult<never> = {
    ok: false,
    error:
      e instanceof CliError
        ? { code: e.code, message: e.message, hint: e.hint }
        : {
            code: ERR.INTERNAL,
            message: e instanceof Error ? e.message : String(e),
          },
  };
  process.stdout.write(`${JSON.stringify(err)}\n`);
  process.exitCode = 1;
}

/** Run a command body; failures go to the JSON envelope or rethrow for humans. */
export async function guardJson<T>(json: boolean, fn: () => Promise<T>): Promise<T | undefined> {
  try {
    return await fn();
  } catch (e) {
    if (json) {
      jsonErr(e);
      return undefined;
    }
    throw e;
  }
}
