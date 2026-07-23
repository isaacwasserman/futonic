/** Typed result pattern for storage and other service/repository methods. */

export type ServiceResult<T, E extends string = never> =
	| { data: T; error: null }
	| { data: null; error: E; message: string };

export function success(): { data: undefined; error: null };
export function success<T>(data: T): { data: T; error: null };
export function success<T>(data?: T) {
	return { data, error: null };
}

export function failure<E extends string>(
	error: E,
	message: string,
): { data: null; error: E; message: string } {
	return { data: null, error, message };
}

export function unknownFailure(
	error: unknown,
): ServiceResult<never, "UNKNOWN"> {
	return failure(
		"UNKNOWN",
		error instanceof Error ? error.message : String(error),
	);
}
