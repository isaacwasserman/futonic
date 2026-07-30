---
"futonic": minor
---

**Breaking:** storage is now built on [files-sdk](https://files-sdk.dev) instead of futonic's own `StorageProvider` interface. `ctx.storage` is a `Files` instance scoped to the service, so a host can back storage with any of files-sdk's 40-plus adapters instead of only the two futonic shipped.

Migrating:

- `ctx.storage` methods are files-sdk's and **throw a `FilesError`** instead of returning a `ServiceResult`. `put`/`get` become `upload`/`download`, `generatePresignedUploadUrl`/`generatePresignedDownloadUrl` become `signedUploadUrl`/`url`, and `copy`, `move`, `exists`, and `listAll` come along for free. A `download`/`head` of a missing key now throws `FilesError` with `code: "NotFound"` rather than resolving to `null`.
- `storage.provider` takes a files-sdk adapter. `createS3Storage` and the `futonic/s3` entry point are removed — use `s3({ bucket, region })` from `files-sdk/s3`, which also drops futonic's four `@aws-sdk` optional peer dependencies. A host-supplied `S3Client` is no longer expressible; configure the adapter instead.
- A service now opts in with `storage: { enabled: true }` rather than by declaring an options object; omitting it, or `{ enabled: false }`, leaves `ctx.storage` off. `storage.constraints` and the service declaration's `constraints` are removed, along with `UploadConstraints`, `resolveConstraints`, and `DEFAULT_UPLOAD_CONSTRAINTS`. Pass `maxSize`/`minSize`/`contentType` per call to `signedUploadUrl`, which is where a provider can actually enforce them.
- `signingKey` and `baseUrl` are now **required** whenever the adapter can't sign its own URLs (the database default, the filesystem, in-memory); constructing the service throws otherwise. Given them, futonic mints HMAC-signed URLs and mounts a transfer route that serves them through the adapter, so `url()`/`signedUploadUrl()` behave the same on every backend.
- The DB store is now a files-sdk adapter over a **per-service** table (`ticketing_storage_objects`) with `key` as its sole primary key, replacing the shared, `owner`-scoped `futonic_storage_objects`. Existing rows need migrating. `generateStorageDrizzleSchema` now takes a service id, and `generateServiceDrizzleSchema` returns the storage table alongside the service's own tables for any service that declares storage — so hosts no longer call it separately. `createDatabaseStorage` and `createInMemoryStorage` are gone; use `databaseAdapter` or files-sdk's `memory()`/`fs()` adapters.
- Presigned uploads always carry a size ceiling, defaulting to 5 GiB (S3's own per-object limit) with `minSize: 0`. An uncapped presign would otherwise fall back to a signed `PUT` that enforces no limit.

`bun run test:s3` runs the storage suite against a real S3 implementation (a throwaway Garage container), covering the streaming, capped-upload, and presigned paths that a mocked client can't.
