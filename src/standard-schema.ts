/**
 * Adapter that wraps a standard-schema provider into a shape compatible
 * with better-call's zod-based validation.
 *
 * Standard Schema spec: https://github.com/standard-schema/standard-schema
 *
 * For v0, this is a minimal bridge. If the input is already a zod schema
 * (has `_def` property), it passes through unchanged.
 */

export interface StandardSchema {
	"~standard": {
		version: number;
		vendor: string;
		validate: (
			value: unknown,
		) => { value: unknown } | { issues: { message: string; path?: string[] }[] };
	};
}

/**
 * Wraps a standard-schema object into a zod-compatible shape for better-call.
 * If the schema already has a `parse` method (zod), returns as-is.
 */
export function toZodCompat(schema: StandardSchema | { parse: unknown }) {
	if ("parse" in schema && typeof schema.parse === "function") {
		return schema;
	}

	const ss = schema as StandardSchema;

	return {
		parse(value: unknown) {
			const result = ss["~standard"].validate(value);
			if ("issues" in result) {
				const messages = result.issues
					.map((i) => `${i.path?.join(".") ?? ""}: ${i.message}`)
					.join("; ");
				throw new Error(`Validation failed: ${messages}`);
			}
			return result.value;
		},
	};
}
