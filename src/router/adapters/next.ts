import type { Router } from "better-call";

/**
 * Creates Next.js App Router route handlers from a better-call router.
 *
 * The router's `handler` already takes a Web Request and returns a Response,
 * which is exactly what Next.js App Router expects.
 *
 * Usage in `app/api/billing/[...path]/route.ts`:
 * ```ts
 * import { toNextJsHandler } from "futonic/next";
 * export const { GET, POST, PUT, DELETE, PATCH } = toNextJsHandler(router);
 * ```
 */
export function toNextJsHandler(router: Router) {
	const handle = async (req: Request) => {
		return router.handler(req);
	};

	return {
		GET: handle,
		POST: handle,
		PUT: handle,
		DELETE: handle,
		PATCH: handle,
	};
}
