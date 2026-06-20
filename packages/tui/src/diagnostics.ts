/**
 * Pluggable diagnostic reporter for the renderer.
 *
 * The TUI records a diagnostic when it hits an unrecoverable render condition
 * (e.g. a line wider than the terminal). To keep this package free of any
 * concrete telemetry/host dependency, the renderer reports through this seam
 * and the host installs a reporter at startup. With no reporter installed the
 * call is a no-op.
 */

export type TuiDiagnosticReporter = (
	scope: string,
	error: unknown,
	context?: Record<string, unknown>,
) => void;

let reporter: TuiDiagnosticReporter | null = null;

/** Install (or clear) the host's diagnostic reporter. */
export function setTuiDiagnosticReporter(fn: TuiDiagnosticReporter | null): void {
	reporter = fn;
}

/** Report a renderer diagnostic to the host, if one is listening. */
export function reportTuiDiagnostic(
	scope: string,
	error: unknown,
	context?: Record<string, unknown>,
): void {
	reporter?.(scope, error, context);
}
