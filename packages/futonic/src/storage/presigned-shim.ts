/**
 * Gives adapters that can't sign URLs (the filesystem, in-memory and DB stores)
 * a working `url` / `signedUploadUrl` pair, backed by a route the framework
 * hosts. An HMAC-signed token carries the key and the upload constraints a
 * signing provider would bake into a policy, so the route can enforce them on
 * the way in and nothing but the token is needed to authorize the transfer.
 */

import type {
	SignUploadOptions,
	SignedUpload,
	UploadOptions,
	UrlOptions,
} from "files-sdk";
import type { FutonicStorageAdapter } from "./types";

const DEFAULT_PATH = "/_storage";
/** Matches the default the signing adapters use when `expiresIn` is omitted. */
const DEFAULT_URL_EXPIRES_IN = 3600;

export type TransferRoute = {
	path: string;
	handler: (request: Request) => Promise<Response>;
};

export type SignedUrlShimOptions = {
	signingKey: string;
	/** Origin the signed URLs point at, including any base path futonic is mounted under. */
	baseUrl: string;
	/** Route path appended to `baseUrl`; defaults to `/_storage`. */
	path?: string;
};

export type ShimmedAdapter = {
	adapter: FutonicStorageAdapter;
	/** Present only when the adapter needed shimming; mount it at `path`. */
	transferRoute?: TransferRoute;
};

type TokenPayload = {
	k: string;
	op: "get" | "put";
	exp: number;
	/** Content type bound into the upload token, enforced by the route. */
	ct?: string;
	/** Content disposition bound into the download token. */
	cd?: string;
	max?: number;
	min?: number;
};

const encoder = new TextEncoder();

/** Encode to a fresh ArrayBuffer-backed view so crypto.subtle's `BufferSource` accepts it. */
function bytesOf(value: string): Uint8Array<ArrayBuffer> {
	const src = encoder.encode(value);
	const out = new Uint8Array(new ArrayBuffer(src.byteLength));
	out.set(src);
	return out;
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
	const signature = await crypto.subtle.sign(
		"HMAC",
		await hmacKey(signingKey),
		bytesOf(body),
	);
	return `${body}.${toBase64Url(new Uint8Array(signature))}`;
}

async function verifyToken(
	token: string,
	signingKey: string,
): Promise<TokenPayload | null> {
	const [body, signature] = token.split(".");
	if (!body || !signature) return null;
	const valid = await crypto.subtle.verify(
		"HMAC",
		await hmacKey(signingKey),
		fromBase64Url(signature),
		bytesOf(body),
	);
	if (!valid) return null;
	try {
		return JSON.parse(
			new TextDecoder().decode(fromBase64Url(body)),
		) as TokenPayload;
	} catch {
		return null;
	}
}

function nowSeconds(): number {
	return Math.floor(Date.now() / 1000);
}

function trimTrailingSlash(url: string): string {
	return url.endsWith("/") ? url.slice(0, -1) : url;
}

/** Duck-typed so a duplicate `files-sdk` install can't break the check. */
function isNotFound(error: unknown): boolean {
	return (error as { code?: string } | null)?.code === "NotFound";
}

function messageOf(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

/**
 * Counts bytes as the upload flows and errors the stream once it passes `max`,
 * so an oversized body is cut off mid-transfer instead of being buffered to be
 * measured.
 */
function meterBody(
	body: ReadableStream<Uint8Array>,
	max?: number,
): {
	stream: ReadableStream<Uint8Array>;
	size: () => number;
	exceeded: () => boolean;
} {
	let seen = 0;
	let exceeded = false;
	const stream = body.pipeThrough(
		new TransformStream<Uint8Array, Uint8Array>({
			transform(chunk, controller) {
				seen += chunk.byteLength;
				if (max !== undefined && seen > max) {
					exceeded = true;
					controller.error(
						new Error(`upload exceeds the limit of ${max} bytes`),
					);
					return;
				}
				controller.enqueue(chunk);
			},
		}),
	);
	return { stream, size: () => seen, exceeded: () => exceeded };
}

/**
 * S3's own ceiling for a single POST/PUT object, so it rules out nothing a
 * direct upload could have done anyway. It isn't a policy — it's there because
 * `maxSize` is what keeps a presigned upload on a size-enforcing path.
 */
export const DEFAULT_MAX_UPLOAD_BYTES: number = 5 * 1024 * 1024 * 1024;

/**
 * Fills in an upload ceiling when the caller didn't set one. Uncapped presigns
 * fall back to a plain signed PUT, which no provider enforces a size on and
 * which files-sdk's S3 adapter currently signs with a checksum of the empty
 * body — so every real upload to it fails. A ceiling avoids both.
 *
 * `minSize` is defaulted to `0` alongside it: the caller asked for no floor, and
 * the injected ceiling shouldn't quietly introduce one (a size-enforcing policy
 * otherwise refuses empty uploads).
 */
export function withUploadSizeCeiling(
	adapter: FutonicStorageAdapter,
	maxSize: number = DEFAULT_MAX_UPLOAD_BYTES,
): FutonicStorageAdapter {
	return Object.assign(Object.create(adapter) as FutonicStorageAdapter, {
		signedUploadUrl: (
			key: string,
			opts: SignUploadOptions,
		): Promise<SignedUpload> =>
			adapter.signedUploadUrl(key, {
				...opts,
				maxSize: opts.maxSize ?? maxSize,
				minSize: opts.minSize ?? (opts.maxSize === undefined ? 0 : undefined),
			}),
	});
}

/**
 * Returns the adapter untouched when it can already sign, so callers can apply
 * this unconditionally; otherwise returns a shimmed adapter plus the route that
 * serves the URLs it mints.
 */
export function shimSignedUrls(
	adapter: FutonicStorageAdapter,
	options: SignedUrlShimOptions,
): ShimmedAdapter {
	if (adapter.signedUrl?.supported) return { adapter };

	const { signingKey } = options;
	const path = options.path ?? DEFAULT_PATH;
	const endpoint = `${trimTrailingSlash(options.baseUrl)}${path}`;
	const link = async (payload: TokenPayload): Promise<string> =>
		`${endpoint}?token=${await signToken(payload, signingKey)}`;

	const url = (key: string, opts?: UrlOptions): Promise<string> =>
		link({
			k: key,
			op: "get",
			exp: nowSeconds() + (opts?.expiresIn ?? DEFAULT_URL_EXPIRES_IN),
			...(opts?.responseContentDisposition
				? { cd: opts.responseContentDisposition }
				: {}),
		});

	// A PUT can carry a size cap here — unlike a provider-signed PUT — because
	// the cap travels in the token and the route below enforces it.
	const signedUploadUrl = async (
		key: string,
		opts: SignUploadOptions,
	): Promise<SignedUpload> => ({
		method: "PUT",
		url: await link({
			k: key,
			op: "put",
			exp: nowSeconds() + opts.expiresIn,
			...(opts.contentType ? { ct: opts.contentType } : {}),
			...(opts.maxSize !== undefined ? { max: opts.maxSize } : {}),
			min: opts.minSize ?? 1,
		}),
		...(opts.contentType
			? { headers: { "content-type": opts.contentType } }
			: {}),
	});

	const receive = async (
		request: Request,
		payload: TokenPayload,
	): Promise<Response> => {
		const contentType = request.headers.get("content-type") ?? undefined;
		if (payload.ct && contentType !== payload.ct) {
			return new Response("content type mismatch", { status: 415 });
		}
		if (!request.body) return new Response("missing body", { status: 400 });
		const declared = Number(request.headers.get("content-length"));
		if (payload.max !== undefined && declared > payload.max) {
			return new Response("payload too large", { status: 413 });
		}

		const body = meterBody(request.body, payload.max);
		const uploadOptions: UploadOptions | undefined = contentType
			? { contentType }
			: undefined;
		try {
			await adapter.upload(payload.k, body.stream, uploadOptions);
		} catch (error) {
			return body.exceeded()
				? new Response("payload too large", { status: 413 })
				: new Response(messageOf(error), { status: 500 });
		}
		if (body.size() < (payload.min ?? 0)) {
			await adapter.delete(payload.k).catch(() => undefined);
			return new Response("payload too small", { status: 400 });
		}
		return new Response(null, { status: 204 });
	};

	const send = async (payload: TokenPayload): Promise<Response> => {
		try {
			const file = await adapter.download(payload.k);
			return new Response(file.stream(), {
				headers: {
					"content-type": file.type,
					...(file.size ? { "content-length": String(file.size) } : {}),
					...(payload.cd ? { "content-disposition": payload.cd } : {}),
				},
			});
		} catch (error) {
			return isNotFound(error)
				? new Response("not found", { status: 404 })
				: new Response(messageOf(error), { status: 500 });
		}
	};

	const handler = async (request: Request): Promise<Response> => {
		const token = new URL(request.url).searchParams.get("token");
		if (!token) return new Response("missing token", { status: 400 });
		const payload = await verifyToken(token, signingKey);
		if (!payload) return new Response("invalid token", { status: 403 });
		if (payload.exp < nowSeconds()) {
			return new Response("expired token", { status: 403 });
		}
		if (request.method === "PUT" && payload.op === "put") {
			return receive(request, payload);
		}
		if (request.method === "GET" && payload.op === "get") {
			return send(payload);
		}
		return new Response("method not allowed", { status: 405 });
	};

	return {
		// Prototype-preserving, so a class-based adapter keeps the methods the
		// shim doesn't override.
		adapter: Object.assign(Object.create(adapter) as FutonicStorageAdapter, {
			signedUrl: { supported: true },
			url,
			signedUploadUrl,
		}),
		transferRoute: { path, handler },
	};
}
