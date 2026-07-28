---
"futonic": minor
---

Add a ready-made S3 storage provider at `futonic/s3`: `createS3Storage({ bucket, client })` takes a bucket and an AWS SDK `S3Client` (defaulting to `new S3Client({})`) and implements the full `StorageProvider` interface. Presigned downloads and uncapped uploads are signed URLs; a capped upload returns a POST form whose policy carries a `content-length-range`, so the framework's `maxSizeBytes` is enforced at the edge. The AWS SDK packages (`@aws-sdk/client-s3`, `@aws-sdk/s3-request-presigner`, `@aws-sdk/s3-presigned-post`) are optional peer dependencies, needed only by hosts that import `futonic/s3`.

Server-side `put` no longer buffers a `ReadableStream` body to measure it: constraint enforcement counts bytes as they flow and errors the stream once `maxSizeBytes` is passed (still reported as `TOO_LARGE`), and the S3 provider uploads streams in parts via `@aws-sdk/lib-storage` so memory stays bounded by the part size instead of the object size.

Presigned `PUT` URLs drop the AWS SDK's default flexible checksum, which would otherwise hoist a checksum of the (absent) request body into the URL and make every real upload fail with `InvalidDigest`.

List cursors are now opaque: the per-service key-prefix wrapper passes them through untouched instead of prefixing them, which would corrupt a cloud store's pagination token.
