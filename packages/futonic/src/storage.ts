/**
 * Blob storage capability injected into services as `ctx.storage`. The host
 * picks a provider (a cloud adapter, or the built-in DB-backed store); the
 * framework namespaces every key by service id and enforces upload constraints.
 */

import { createRequire } from "node:module";
import { Kysely, sql } from "kysely";
import { STORAGE_TABLE_NAME } from "./drizzle";
import {
	type DatabaseConnection,
	type DatabaseProvider,
	createDialect,
} from "./kysely";
import { type ServiceResult, failure, success, unknownFailure } from "./result";

export type StorageError =
	| "NOT_FOUND"
	| "ACCESS_DENIED"
	| "TOO_LARGE"
	| "UNSUPPORTED_TYPE"
	| "UNSUPPORTED"
	| "UNKNOWN";

export type UploadConstraints = {
	maxSizeBytes?: number;
	/** Allowlist of content types; `[]`/`undefined` means any. */
	allowedContentTypes?: string[];
	uploadUrlTtlSeconds?: number;
	downloadUrlTtlSeconds?: number;
};

export const DEFAULT_UPLOAD_CONSTRAINTS: Required<UploadConstraints> = {
	maxSizeBytes: 25 * 1024 * 1024,
	allowedContentTypes: [],
	uploadUrlTtlSeconds: 900,
	downloadUrlTtlSeconds: 900,
};

/**
 * A presigned upload. A plain `PUT` can't cap size (SigV4 signs an exact
 * `Content-Length`, not a range), so providers should return a `POST` form —
 * which can carry a `content-length-range` policy — whenever a `maxSizeBytes`
 * cap is set.
 */
export type PresignedUpload =
	| { method: "PUT"; url: string; headers?: Record<string, string> }
	| { method: "POST"; url: string; fields: Record<string, string> };

export type GetResult = {
	body: ReadableStream;
	contentType?: string;
	size: number;
} | null;

export type HeadResult = { size: number; contentType?: string } | null;

/** The host-implemented (or built-in) blob storage interface. */
export type StorageProvider = {
	generatePresignedUploadUrl(input: {
		key: string;
		contentType?: string;
		/** Framework-injected from the effective constraints; providers may honor it. */
		maxSizeBytes?: number;
		/** Framework-injected URL lifetime, in seconds. */
		ttlSeconds?: number;
	}): Promise<ServiceResult<PresignedUpload, StorageError>>;
	generatePresignedDownloadUrl(input: {
		key: string;
		downloadFilename?: string;
		/** Framework-injected URL lifetime, in seconds. */
		ttlSeconds?: number;
	}): Promise<ServiceResult<{ url: string }, StorageError>>;
	put(input: {
		key: string;
		body: Uint8Array | ReadableStream;
		contentType?: string;
	}): Promise<ServiceResult<undefined, StorageError>>;
	/** `data: null` means the object is absent (a normal outcome); `error` is a real failure. */
	get(input: {
		key: string;
	}): Promise<ServiceResult<GetResult, StorageError>>;
	head(input: {
		key: string;
	}): Promise<ServiceResult<HeadResult, StorageError>>;
	delete(input: { key: string }): Promise<
		ServiceResult<undefined, StorageError>
	>;
	list(input: {
		prefix?: string;
		limit?: number;
		cursor?: string;
	}): Promise<ServiceResult<{ keys: string[]; cursor?: string }, StorageError>>;

	/**
	 * Present only on stores that need futonic to host their transfer route (the
	 * built-in DB store). `createHandler` mounts `handle` at `path`.
	 */
	readonly transferRoute?: {
		path: string;
		handle: (request: Request) => Promise<Response>;
	};
};

/**
 * A service's storage declaration. Its *presence* on a service definition turns
 * storage on for that service (surfacing `ctx.storage`); `constraints` narrows
 * the framework defaults for that service.
 */
export type StorageDeclaration = {
	constraints?: Partial<UploadConstraints>;
};

/**
 * Effective upload constraints. TTLs follow `defaults ← service ← host`, but the
 * actual limits only ever narrow: `maxSizeBytes` is the min across the defaults
 * and any layer, and `allowedContentTypes` is the intersection of the layers'
 * non-empty allowlists — so neither a service nor the host can relax a cap set
 * by another layer.
 */
export function resolveConstraints(
	service?: Partial<UploadConstraints>,
	host?: Partial<UploadConstraints>,
): Required<UploadConstraints> {
	const defined = (
		c?: Partial<UploadConstraints>,
	): Partial<UploadConstraints> =>
		Object.fromEntries(
			Object.entries(c ?? {}).filter(([, v]) => v !== undefined),
		);
	const merged = {
		...DEFAULT_UPLOAD_CONSTRAINTS,
		...defined(service),
		...defined(host),
	};
	const sizes = [service?.maxSizeBytes, host?.maxSizeBytes].filter(
		(v): v is number => v !== undefined,
	);
	const allowLists = [
		service?.allowedContentTypes,
		host?.allowedContentTypes,
	].filter((v): v is string[] => v !== undefined && v.length > 0);
	return {
		...merged,
		maxSizeBytes: Math.min(DEFAULT_UPLOAD_CONSTRAINTS.maxSizeBytes, ...sizes),
		allowedContentTypes:
			allowLists.length === 0
				? []
				: allowLists.reduce((a, b) => a.filter((t) => b.includes(t))),
	};
}

function isKeySafe(key: string): boolean {
	return (
		key.length > 0 && !key.startsWith("/") && !key.split("/").includes("..")
	);
}

/**
 * Namespaces every key/prefix with `${id}/` (isolation parity with the DB's
 * table prefixing) and rejects traversal keys. `list` results are un-prefixed
 * back to the service's logical key space.
 */
export function withServiceKeyPrefix(
	store: StorageProvider,
	id: string,
): StorageProvider {
	const scope = `${id}/`;
	const scoped = (key: string) => `${scope}${key}`;
	const denied = <E extends StorageError>() =>
		failure("ACCESS_DENIED" as E, "invalid key: traversal or absolute path");

	return {
		transferRoute: store.transferRoute,
		generatePresignedUploadUrl: (input) =>
			isKeySafe(input.key)
				? store.generatePresignedUploadUrl({ ...input, key: scoped(input.key) })
				: Promise.resolve(denied()),
		generatePresignedDownloadUrl: (input) =>
			isKeySafe(input.key)
				? store.generatePresignedDownloadUrl({
						...input,
						key: scoped(input.key),
					})
				: Promise.resolve(denied()),
		put: (input) =>
			isKeySafe(input.key)
				? store.put({ ...input, key: scoped(input.key) })
				: Promise.resolve(denied()),
		get: (input) =>
			isKeySafe(input.key)
				? store.get({ ...input, key: scoped(input.key) })
				: Promise.resolve(denied()),
		head: (input) =>
			isKeySafe(input.key)
				? store.head({ ...input, key: scoped(input.key) })
				: Promise.resolve(denied()),
		delete: (input) =>
			isKeySafe(input.key)
				? store.delete({ ...input, key: scoped(input.key) })
				: Promise.resolve(denied()),
		list: async (input) => {
			if (input.prefix && !isKeySafe(input.prefix)) return denied();
			const unscope = (k: string) =>
				k.startsWith(scope) ? k.slice(scope.length) : k;
			const result = await store.list({
				...input,
				prefix: `${scope}${input.prefix ?? ""}`,
				cursor: input.cursor ? scoped(input.cursor) : undefined,
			});
			if (result.error) return result;
			return success({
				keys: result.data.keys.map(unscope),
				cursor: result.data.cursor ? unscope(result.data.cursor) : undefined,
			});
		},
	};
}

async function bodyByteLength(
	body: Uint8Array | ReadableStream,
): Promise<{ bytes: Uint8Array; size: number }> {
	if (body instanceof Uint8Array) return { bytes: body, size: body.byteLength };
	const bytes = new Uint8Array(await new Response(body).arrayBuffer());
	return { bytes, size: bytes.byteLength };
}

function contentTypeAllowed(allowed: string[], contentType?: string): boolean {
	return (
		allowed.length === 0 || (!!contentType && allowed.includes(contentType))
	);
}

/**
 * Enforces `maxSizeBytes`/`allowedContentTypes` on server-side `put` and passes
 * the constraints down to presign (providers decide how to honor them).
 */
export function withConstraints(
	store: StorageProvider,
	constraints: Required<UploadConstraints>,
): StorageProvider {
	return {
		...store,
		generatePresignedUploadUrl: (input) => {
			if (
				!contentTypeAllowed(constraints.allowedContentTypes, input.contentType)
			) {
				return Promise.resolve(
					failure(
						"UNSUPPORTED_TYPE",
						`content type ${input.contentType ?? "(none)"} is not allowed`,
					),
				);
			}
			return store.generatePresignedUploadUrl({
				...input,
				maxSizeBytes: Math.min(
					input.maxSizeBytes ?? constraints.maxSizeBytes,
					constraints.maxSizeBytes,
				),
				ttlSeconds: input.ttlSeconds ?? constraints.uploadUrlTtlSeconds,
			});
		},
		generatePresignedDownloadUrl: (input) =>
			store.generatePresignedDownloadUrl({
				...input,
				ttlSeconds: input.ttlSeconds ?? constraints.downloadUrlTtlSeconds,
			}),
		put: async (input) => {
			if (
				!contentTypeAllowed(constraints.allowedContentTypes, input.contentType)
			) {
				return failure(
					"UNSUPPORTED_TYPE",
					`content type ${input.contentType ?? "(none)"} is not allowed`,
				);
			}
			const { bytes, size } = await bodyByteLength(input.body);
			if (size > constraints.maxSizeBytes) {
				return failure(
					"TOO_LARGE",
					`object is ${size} bytes, exceeds limit of ${constraints.maxSizeBytes}`,
				);
			}
			return store.put({ ...input, body: bytes });
		},
	};
}

// --- Built-in DB-backed store ---------------------------------------------

const TABLE = STORAGE_TABLE_NAME;
const TRANSFER_PATH = "/_storage";

type StorageRow = {
	owner: string;
	key: string;
	content_type: string | null;
	size: number;
	data: Uint8Array;
	created_at: string;
};
type StorageDB = { [TABLE]: StorageRow };

type TokenPayload = {
	k: string;
	op: "put" | "get";
	exp: number;
	max?: number;
	ct?: string;
};

const enc = new TextEncoder();

/** Encode to a fresh ArrayBuffer-backed view so crypto.subtle's `BufferSource` accepts it. */
function bytesOf(value: string): Uint8Array<ArrayBuffer> {
	const src = enc.encode(value);
	const out = new Uint8Array(new ArrayBuffer(src.byteLength));
	out.set(src);
	return out;
}

function nowSeconds(): number {
	return Math.floor(Date.now() / 1000);
}

function toBase64Url(bytes: Uint8Array): string {
	let binary = "";
	for (const b of bytes) binary += String.fromCharCode(b);
	return btoa(binary)
		.replace(/\+/g, "-")
		.replace(/\//g, "_")
		.replace(/=+$/, "");
}

function fromBase64Url(value: string): Uint8Array<ArrayBuffer> {
	const binary = atob(value.replace(/-/g, "+").replace(/_/g, "/"));
	const out = new Uint8Array(new ArrayBuffer(binary.length));
	for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
	return out;
}

async function hmacKey(signingKey: string): Promise<CryptoKey> {
	return crypto.subtle.importKey(
		"raw",
		bytesOf(signingKey),
		{ name: "HMAC", hash: "SHA-256" },
		false,
		["sign", "verify"],
	);
}

async function signToken(
	payload: TokenPayload,
	signingKey: string,
): Promise<string> {
	const body = toBase64Url(bytesOf(JSON.stringify(payload)));
	const sig = await crypto.subtle.sign(
		"HMAC",
		await hmacKey(signingKey),
		bytesOf(body),
	);
	return `${body}.${toBase64Url(new Uint8Array(sig))}`;
}

async function verifyToken(
	token: string,
	signingKey: string,
): Promise<TokenPayload | null> {
	const [body, sig] = token.split(".");
	if (!body || !sig) return null;
	const ok = await crypto.subtle.verify(
		"HMAC",
		await hmacKey(signingKey),
		fromBase64Url(sig),
		bytesOf(body),
	);
	if (!ok) return null;
	try {
		return JSON.parse(
			new TextDecoder().decode(fromBase64Url(body)),
		) as TokenPayload;
	} catch {
		return null;
	}
}

function trimTrailingSlash(url: string): string {
	return url.endsWith("/") ? url.slice(0, -1) : url;
}

const LIKE_ESCAPE_CHAR = "#";

/** Escape LIKE wildcards so a prefix matches literally (`_`/`%` are common in keys). */
function escapeLikePrefix(prefix: string): string {
	return prefix.replace(/[#%_]/g, (c) => `${LIKE_ESCAPE_CHAR}${c}`);
}

function buildStorageKysely(
	connection: DatabaseConnection,
	provider: DatabaseProvider,
): Kysely<StorageDB> {
	return new Kysely<StorageDB>({
		dialect: createDialect(connection, provider),
	});
}

/**
 * A DB-backed {@link StorageProvider} for development / proof-of-concept use.
 * Blobs live in the shared, framework-owned `futonic_storage_objects` table
 * (see {@link generateStorageDrizzleSchema}), where rows are scoped by the
 * `owner` column so multiple services can share one table. The table is also
 * auto-created on first use, so it works without migrations too. Not for
 * production or large objects — use a cloud adapter there. Presign works only
 * when `signingKey` and `baseUrl` are supplied (it mints signed URLs to the
 * transfer route futonic mounts).
 */
export function createDatabaseStorage(options: {
	connection: DatabaseConnection;
	provider: DatabaseProvider;
	/** The service that owns this store's rows (the `owner` column value). */
	owner: string;
	signingKey?: string;
	baseUrl?: string;
}): StorageProvider {
	const { connection, provider, owner, signingKey, baseUrl } = options;
	const db = buildStorageKysely(connection, provider);

	let ready: Promise<void> | null = null;
	const ensure = () => {
		if (!ready) {
			const blobType =
				provider === "pg"
					? sql`bytea`
					: provider === "mysql"
						? sql`longblob`
						: sql`blob`;
			ready = db.schema
				.createTable(TABLE)
				.ifNotExists()
				.addColumn("owner", "varchar(255)", (c) => c.notNull())
				.addColumn("key", "varchar(255)", (c) => c.notNull())
				.addColumn("content_type", "varchar(255)")
				.addColumn("size", "integer", (c) => c.notNull())
				.addColumn("data", blobType, (c) => c.notNull())
				.addColumn("created_at", "varchar(64)", (c) => c.notNull())
				.addPrimaryKeyConstraint(`${TABLE}_pk`, ["owner", "key"])
				.execute()
				.then(() => undefined)
				.catch((e) => {
					ready = null;
					throw e;
				});
		}
		return ready;
	};

	const rawPut = async (input: {
		key: string;
		body: Uint8Array | ReadableStream;
		contentType?: string;
	}): Promise<ServiceResult<undefined, StorageError>> => {
		try {
			await ensure();
			const { bytes, size } = await bodyByteLength(input.body);
			await db
				.deleteFrom(TABLE)
				.where("owner", "=", owner)
				.where("key", "=", input.key)
				.execute();
			await db
				.insertInto(TABLE)
				.values({
					owner,
					key: input.key,
					content_type: input.contentType ?? null,
					size,
					data: Buffer.from(bytes),
					created_at: new Date().toISOString(),
				})
				.execute();
			return success();
		} catch (e) {
			return unknownFailure(e);
		}
	};

	const rawGet = async (input: {
		key: string;
	}): Promise<ServiceResult<GetResult, StorageError>> => {
		try {
			await ensure();
			const row = await db
				.selectFrom(TABLE)
				.selectAll()
				.where("owner", "=", owner)
				.where("key", "=", input.key)
				.executeTakeFirst();
			if (!row) return success(null);
			const bytes = new Uint8Array(row.data);
			return success({
				body: new Response(bytes).body as ReadableStream,
				contentType: row.content_type ?? undefined,
				size: row.size,
			});
		} catch (e) {
			return unknownFailure(e);
		}
	};

	const store: StorageProvider = {
		generatePresignedUploadUrl: async (input) => {
			if (!signingKey || !baseUrl) {
				return failure(
					"UNSUPPORTED",
					"presign requires signingKey and baseUrl",
				);
			}
			const exp =
				nowSeconds() +
				(input.ttlSeconds ?? DEFAULT_UPLOAD_CONSTRAINTS.uploadUrlTtlSeconds);
			const token = await signToken(
				{
					k: input.key,
					op: "put",
					exp,
					max: input.maxSizeBytes,
					ct: input.contentType,
				},
				signingKey,
			);
			return success({
				method: "PUT",
				url: `${trimTrailingSlash(baseUrl)}${TRANSFER_PATH}?token=${token}`,
			});
		},
		generatePresignedDownloadUrl: async (input) => {
			if (!signingKey || !baseUrl) {
				return failure(
					"UNSUPPORTED",
					"presign requires signingKey and baseUrl",
				);
			}
			const exp =
				nowSeconds() +
				(input.ttlSeconds ?? DEFAULT_UPLOAD_CONSTRAINTS.downloadUrlTtlSeconds);
			const token = await signToken(
				{ k: input.key, op: "get", exp },
				signingKey,
			);
			return success({
				url: `${trimTrailingSlash(baseUrl)}${TRANSFER_PATH}?token=${token}`,
			});
		},
		put: rawPut,
		get: rawGet,
		head: async (input) => {
			try {
				await ensure();
				const row = await db
					.selectFrom(TABLE)
					.select(["size", "content_type"])
					.where("owner", "=", owner)
					.where("key", "=", input.key)
					.executeTakeFirst();
				if (!row) return success(null);
				return success({
					size: row.size,
					contentType: row.content_type ?? undefined,
				});
			} catch (e) {
				return unknownFailure(e);
			}
		},
		delete: async (input) => {
			try {
				await ensure();
				await db
					.deleteFrom(TABLE)
					.where("owner", "=", owner)
					.where("key", "=", input.key)
					.execute();
				return success();
			} catch (e) {
				return unknownFailure(e);
			}
		},
		list: async (input) => {
			try {
				await ensure();
				const limit = Math.min(input.limit ?? 1000, 1000);
				let query = db
					.selectFrom(TABLE)
					.select("key")
					.where("owner", "=", owner)
					.orderBy("key");
				if (input.prefix)
					query = query.where(
						sql<boolean>`${sql.ref("key")} like ${`${escapeLikePrefix(input.prefix)}%`} escape '#'`,
					);
				if (input.cursor) query = query.where("key", ">", input.cursor);
				const rows = await query.limit(limit + 1).execute();
				const keys = rows.slice(0, limit).map((r) => r.key);
				const cursor = rows.length > limit ? keys[keys.length - 1] : undefined;
				return success({ keys, cursor });
			} catch (e) {
				return unknownFailure(e);
			}
		},
		transferRoute: signingKey
			? {
					path: TRANSFER_PATH,
					handle: async (request) => {
						const token = new URL(request.url).searchParams.get("token");
						if (!token) return new Response("missing token", { status: 400 });
						const payload = await verifyToken(token, signingKey);
						if (!payload) return new Response("invalid token", { status: 403 });
						if (payload.exp < nowSeconds()) {
							return new Response("expired token", { status: 403 });
						}
						if (request.method === "PUT" && payload.op === "put") {
							const contentType =
								request.headers.get("content-type") ?? undefined;
							if (payload.ct && contentType !== payload.ct) {
								return new Response("content type mismatch", { status: 415 });
							}
							const bytes = new Uint8Array(await request.arrayBuffer());
							if (payload.max !== undefined && bytes.byteLength > payload.max) {
								return new Response("payload too large", { status: 413 });
							}
							const result = await rawPut({
								key: payload.k,
								body: bytes,
								contentType,
							});
							return result.error
								? new Response(result.message, { status: 500 })
								: new Response(null, { status: 204 });
						}
						if (request.method === "GET" && payload.op === "get") {
							const result = await rawGet({ key: payload.k });
							if (result.error)
								return new Response(result.message, { status: 500 });
							if (!result.data)
								return new Response("not found", { status: 404 });
							return new Response(result.data.body, {
								headers: result.data.contentType
									? { "content-type": result.data.contentType }
									: {},
							});
						}
						return new Response("method not allowed", { status: 405 });
					},
				}
			: undefined,
	};

	return store;
}

// --- In-memory store (node:sqlite) ----------------------------------------

type NodeSqliteStatement = {
	all: (...params: unknown[]) => unknown;
	run: (...params: unknown[]) => unknown;
	iterate?: (...params: unknown[]) => unknown;
};
type NodeSqliteDatabase = { prepare: (sql: string) => NodeSqliteStatement };

/**
 * Adapt a `node:sqlite` database to the better-sqlite3-shaped API Kysely's
 * `SqliteDialect` expects: expose `stmt.reader`, and spread bound parameters
 * (Kysely passes them as one array; `node:sqlite` takes them as rest args).
 */
function adaptNodeSqlite(db: NodeSqliteDatabase): DatabaseConnection {
	const passthrough = (target: object, prop: string | symbol) => {
		const value = (target as Record<string | symbol, unknown>)[prop];
		return typeof value === "function"
			? (value as (...a: unknown[]) => unknown).bind(target)
			: value;
	};
	const wrapStatement = (sql: string, stmt: NodeSqliteStatement) => {
		const upper = sql.trimStart().toUpperCase();
		const reader =
			upper.startsWith("SELECT") ||
			upper.startsWith("WITH") ||
			upper.startsWith("PRAGMA") ||
			/\bRETURNING\b/i.test(sql);
		return new Proxy(stmt, {
			get(target, prop) {
				if (prop === "reader") return reader;
				if (prop === "all")
					return (params: unknown[]) => target.all(...(params ?? []));
				if (prop === "run")
					return (params: unknown[]) => target.run(...(params ?? []));
				if (prop === "iterate")
					return (params: unknown[]) => target.iterate?.(...(params ?? []));
				return passthrough(target, prop);
			},
		});
	};
	return new Proxy(db, {
		get(target, prop) {
			if (prop === "prepare")
				return (sql: string) => wrapStatement(sql, target.prepare(sql));
			return passthrough(target, prop);
		},
	}) as unknown as DatabaseConnection;
}

/**
 * In-memory {@link StorageProvider} for tests and local development — a
 * {@link createDatabaseStorage} on an ephemeral `node:sqlite` database. Requires
 * Node.js ≥ 22.5 (or a runtime that provides `node:sqlite`); for anything else,
 * pass your own connection to {@link createDatabaseStorage}.
 */
export function createInMemoryStorage(options?: {
	owner?: string;
	signingKey?: string;
	baseUrl?: string;
}): StorageProvider {
	let DatabaseSync: new (path: string) => NodeSqliteDatabase;
	try {
		({ DatabaseSync } = createRequire(import.meta.url)("node:sqlite"));
	} catch {
		throw new Error(
			"createInMemoryStorage requires node:sqlite (Node.js >= 22.5). On other runtimes, pass a connection to createDatabaseStorage instead.",
		);
	}
	return createDatabaseStorage({
		connection: adaptNodeSqlite(new DatabaseSync(":memory:")),
		provider: "sqlite",
		owner: options?.owner ?? "default",
		signingKey: options?.signingKey,
		baseUrl: options?.baseUrl,
	});
}
