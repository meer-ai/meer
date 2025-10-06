let verbose = false;

export function setVerboseLogging(value: boolean): void {
  verbose = value;
}

export function isVerboseLogging(): boolean {
  return verbose;
}

export function logVerbose(message?: unknown, ...optional: unknown[]): void {
  if (!verbose) {
    return;
  }
  if (optional.length > 0) {
    console.log(message, ...optional);
  } else if (message !== undefined) {
    console.log(message);
  }
}
