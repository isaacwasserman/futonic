export interface ProxyOptions {
	/** Upstream origin to forward requests to, e.g. `http://127.0.0.1:38291`. */
	upstreamOrigin: string;
	/** Path that the service is mounted at on the host, e.g. `/admin/queues`. */
	mountPath: string;
}

/**
 * Hop-by-hop headers that must not be forwarded across a proxy boundary
 * (RFC 7230 §6.1). `connection` is filtered separately because its value
 * enumerates additional hop-by-hop headers to strip.
 */
const HOP_BY_HOP = new Set([
	"connection",
	"keep-alive",
	"proxy-authenticate",
	"proxy-authorization",
	"te",
	"trailer",
	"transfer-encoding",
	"upgrade",
	"host",
	"content-length",
]);

function normalizeMount(mountPath: string): string {
	if (!mountPath.startsWith("/")) mountPath = `/${mountPath}`;
	if (mountPath.length > 1 && mountPath.endsWith("/")) {
		mountPath = mountPath.slice(0, -1);
	}
	return mountPath;
}

/**
 * Builds the upstream URL by stripping the service mount prefix from the
 * incoming path. The upstream dashboard has no concept of a basename — it
 * expects requests at `/`, `/jobs`, `/assets/*`, etc.
 */
function rewriteUrl(
	requestUrl: string,
	mountPath: string,
	upstreamOrigin: string,
): string {
	const url = new URL(requestUrl);
	const mount = normalizeMount(mountPath);

	let path = url.pathname;
	if (path === mount) {
		path = "/";
	} else if (path.startsWith(`${mount}/`)) {
		path = path.slice(mount.length);
	}

	return `${upstreamOrigin}${path}${url.search}`;
}

function stripHopByHop(headers: Headers): Headers {
	const out = new Headers(headers);
	const connection = headers.get("connection");
	if (connection) {
		for (const name of connection.split(",")) {
			out.delete(name.trim());
		}
	}
	for (const name of HOP_BY_HOP) out.delete(name);
	return out;
}

/**
 * Creates a reverse-proxy handler that forwards incoming `Request` objects
 * to the upstream dashboard and returns its `Response`.
 *
 * The proxy strips the mount prefix from the request path before forwarding,
 * so the dashboard sees requests as if it were mounted at `/`. Responses are
 * streamed back with hop-by-hop headers removed.
 */
export function createDashboardProxy(options: ProxyOptions) {
	const upstream = options.upstreamOrigin.replace(/\/$/, "");

	return async function handler(request: Request): Promise<Response> {
		const upstreamURL = rewriteUrl(request.url, options.mountPath, upstream);

		const init: RequestInit = {
			method: request.method,
			headers: stripHopByHop(request.headers),
			redirect: "manual",
		};

		// GET/HEAD must not include a body per fetch spec
		if (request.method !== "GET" && request.method !== "HEAD") {
			init.body = request.body;
			(init as { duplex?: "half" }).duplex = "half";
		}

		let upstreamResponse: Response;
		try {
			upstreamResponse = await fetch(upstreamURL, init);
		} catch (err) {
			return new Response(
				`Failed to reach @pg-boss/dashboard upstream: ${String(err)}`,
				{ status: 502, headers: { "content-type": "text/plain" } },
			);
		}

		const responseHeaders = stripHopByHop(upstreamResponse.headers);

		return new Response(upstreamResponse.body, {
			status: upstreamResponse.status,
			statusText: upstreamResponse.statusText,
			headers: responseHeaders,
		});
	};
}
