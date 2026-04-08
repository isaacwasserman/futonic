/**
 * Re-exports better-call's client utilities for type-safe API consumption.
 *
 * Usage:
 * ```ts
 * import { createClient } from "futonic/client";
 * import type { billingRouter } from "@acme/billing";
 *
 * const client = createClient<typeof billingRouter>({
 *   baseURL: "/api/billing",
 * });
 * ```
 */
export { createClient } from "better-call/client";
