/** Futonic's OpenAPI document generator for a better-call endpoint set. */

import type { Endpoint } from "better-call";
import type { OpenAPIV3_1 } from "openapi-types";

type Json = Record<string, unknown>;

export type OpenApiInfo = OpenAPIV3_1.InfoObject;
export type SecurityScheme = OpenAPIV3_1.SecuritySchemeObject;
export type SecurityRequirement = OpenAPIV3_1.SecurityRequirementObject;

export type OpenApiOptions = {
	/** Disable the OpenAPI route entirely. */
	disabled?: boolean;
	/** Path the reference UI is served from. Defaults to `/reference`. */
	path?: string;
	/** Document `info` overrides. */
	info?: Partial<OpenApiInfo>;
	/** `servers` entries for the document. */
	servers?: OpenAPIV3_1.ServerObject[];
	/**
	 * Named security schemes, emitted under `components.securitySchemes`. Futonic
	 * is auth-agnostic and infers none — the host declares whatever its auth uses
	 * (e.g. a better-auth session cookie or a bearer token).
	 */
	securitySchemes?: Record<string, SecurityScheme>;
	/**
	 * Document-wide security requirement applied to every operation (unless an
	 * endpoint overrides it via `metadata.openapi.security`).
	 */
	security?: SecurityRequirement[];
	/** Scalar reference-UI theme. */
	theme?: string;
};

type EndpointOptions = {
	method: string | string[];
	body?: unknown;
	query?: unknown;
	metadata?: { SERVER_ONLY?: boolean; openapi?: OpenAPIV3_1.OperationObject };
};

const DEFAULT_INFO: OpenApiInfo = {
	title: "API Reference",
	description: "",
	version: "1.0.0",
};

const HTTP_METHODS = new Set([
	"get",
	"post",
	"put",
	"patch",
	"delete",
	"head",
	"options",
	"trace",
]);

/** Methods that never carry a request body in the document. */
const BODYLESS_METHODS = new Set(["get", "head"]);

const ERROR_DESCRIPTIONS: Record<string, string> = {
	"400":
		"Bad Request. Usually due to missing parameters, or invalid parameters.",
	"401": "Unauthorized. Due to missing or invalid authentication.",
	"403":
		"Forbidden. You do not have permission to access this resource or to perform this action.",
	"404": "Not Found. The requested resource was not found.",
	"429":
		"Too Many Requests. You have exceeded the rate limit. Try again later.",
	"500":
		"Internal Server Error. This is a problem with the server that you cannot fix.",
};

const DEFAULT_RESPONSES: OpenAPIV3_1.ResponsesObject = Object.fromEntries(
	Object.entries(ERROR_DESCRIPTIONS).map(([code, description]) => [
		code,
		{
			description,
			content: {
				"application/json": {
					schema: {
						type: "object",
						properties: { message: { type: "string" } },
						required: ["message"],
					},
				},
			},
		},
	]),
);

/** Rewrite rou3-style `:param` segments to OpenAPI `{param}`, collecting names. */
function toOpenApiPath(path: string): { path: string; params: string[] } {
	const params: string[] = [];
	const converted = path
		.split("/")
		.map((segment) => {
			if (!segment.startsWith(":")) return segment;
			const name = segment.slice(1);
			params.push(name);
			return `{${name}}`;
		})
		.join("/");
	return { path: converted, params };
}

/**
 * Best-effort JSON Schema for a Standard Schema validator. Uses the validator's
 * own `toJsonSchema()` (e.g. arktype) when present; callers fall back otherwise.
 */
function schemaToJsonSchema(schema: unknown): OpenAPIV3_1.SchemaObject {
	// A validator may be an object or a callable (e.g. arktype's `Type`).
	const fallback: OpenAPIV3_1.SchemaObject = { type: "object" };
	if (
		schema === null ||
		(typeof schema !== "object" && typeof schema !== "function")
	) {
		return fallback;
	}
	const withMethod = schema as { toJsonSchema?: () => unknown };
	if (typeof withMethod.toJsonSchema !== "function") return fallback;
	try {
		const result = withMethod.toJsonSchema();
		if (!result || typeof result !== "object") return fallback;
		const { $schema, ...rest } = result as Json;
		return rest as OpenAPIV3_1.SchemaObject;
	} catch {
		return fallback;
	}
}

function queryParameters(schema: unknown): OpenAPIV3_1.ParameterObject[] {
	const json = schemaToJsonSchema(schema) as {
		properties?: Record<string, OpenAPIV3_1.SchemaObject>;
		required?: string[];
	};
	if (!json.properties) return [];
	const required = new Set(json.required ?? []);
	return Object.entries(json.properties).map(([name, schema]) => ({
		name,
		in: "query",
		required: required.has(name),
		schema,
	})) as OpenAPIV3_1.ParameterObject[];
}

function requestBody(
	options: EndpointOptions,
): OpenAPIV3_1.RequestBodyObject | undefined {
	const override = options.metadata?.openapi?.requestBody;
	if (override) return override as OpenAPIV3_1.RequestBodyObject;
	if (!options.body) return undefined;
	return {
		required: true,
		content: {
			"application/json": { schema: schemaToJsonSchema(options.body) },
		},
	};
}

/**
 * Build an OpenAPI 3.1 document from a better-call endpoint set. Unlike
 * better-call's own generator this merges every method onto its path (rather
 * than overwriting), emits all HTTP verbs, and derives path parameters.
 */
export function generateOpenApiDocument(
	endpoints: Record<string, Endpoint>,
	options: OpenApiOptions = {},
): OpenAPIV3_1.Document {
	const paths: OpenAPIV3_1.PathsObject = {};

	for (const endpoint of Object.values(endpoints)) {
		if (!endpoint?.path || !endpoint.options) continue;
		const opts = endpoint.options as EndpointOptions;
		if (opts.metadata?.SERVER_ONLY) continue;

		const { path, params } = toOpenApiPath(endpoint.path);
		const pathParameters = params.map((name) => ({
			name,
			in: "path",
			required: true,
			schema: { type: "string" },
		})) as OpenAPIV3_1.ParameterObject[];
		const methods = Array.isArray(opts.method) ? opts.method : [opts.method];
		const meta = opts.metadata?.openapi;
		const parameters = [
			...pathParameters,
			...queryParameters(opts.query),
			...((meta?.parameters as OpenAPIV3_1.ParameterObject[]) ?? []),
		];

		paths[path] ??= {};
		const pathItem = paths[path] as Record<string, OpenAPIV3_1.OperationObject>;
		for (const rawMethod of methods) {
			const method = String(rawMethod).toLowerCase();
			if (!HTTP_METHODS.has(method)) continue;
			const body = BODYLESS_METHODS.has(method) ? undefined : requestBody(opts);
			pathItem[method] = {
				tags: ["Default", ...(meta?.tags ?? [])],
				summary: meta?.summary,
				description: meta?.description,
				operationId: meta?.operationId,
				security: meta?.security,
				...(parameters.length > 0 && { parameters }),
				...(body && { requestBody: body }),
				responses: { ...DEFAULT_RESPONSES, ...meta?.responses },
			};
		}
	}

	return {
		openapi: "3.1.1",
		info: { ...DEFAULT_INFO, ...options.info },
		servers: options.servers ?? [],
		security: options.security,
		components: {
			...(options.securitySchemes && {
				securitySchemes: options.securitySchemes,
			}),
		},
		tags: [
			{ name: "Default", description: "Default endpoints for this service." },
		],
		paths,
	};
}

/** A Scalar reference page that renders the given document. */
export function openApiReferenceHtml(
	doc: OpenAPIV3_1.Document,
	theme = "saturn",
): string {
	const embedded = JSON.stringify(doc).replace(/</g, "\\u003c");
	const configuration = JSON.stringify(JSON.stringify({ theme }));
	return `<!doctype html>
<html>
  <head>
    <title>API Reference</title>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
  </head>
  <body>
    <script id="api-reference" type="application/json">${embedded}</script>
    <script>
      document.getElementById('api-reference').dataset.configuration = ${configuration};
    </script>
    <script src="https://cdn.jsdelivr.net/npm/@scalar/api-reference"></script>
  </body>
</html>`;
}
