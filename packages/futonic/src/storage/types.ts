import type { Adapter, Files } from "files-sdk";

/** The storage backend a host supplies; futonic wraps it for the service. */
export type FutonicStorageAdapter = Adapter;

/** The handle a service that declares storage gets as `ctx.storage`. */
export type FutonicStorage = Files;

/** A service opts into storage with `{ enabled: true }`; the default is off. */
export type FutonicStorageOptions = { enabled: boolean };
