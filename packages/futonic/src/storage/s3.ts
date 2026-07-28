/**
 * S3-backed {@link StorageProvider}, built on the AWS SDK v3. Lives behind the
 * `futonic/s3` entry point so only hosts that use it need the SDK installed.
 */

import {
	DeleteObjectCommand,
	GetObjectCommand,
	HeadObjectCommand,
	ListObjectsV2Command,
	PutObjectCommand,
	S3Client,
} from "@aws-sdk/client-s3";
import { Upload } from "@aws-sdk/lib-storage";
import { createPresignedPost } from "@aws-sdk/s3-presigned-post";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import {
	type ServiceResult,
	failure,
	success,
	unknownFailure,
} from "../result";
import {
	DEFAULT_UPLOAD_CONSTRAINTS,
	type GetResult,
	type HeadResult,
	type PresignedUpload,
	type StorageError,
	type StorageProvider,
} from "./index";

export type S3StorageOptions = {
	bucket: string;
	/** Defaults to an `S3Client` configured from the ambient AWS environment. */
	client?: S3Client;
};

type AwsError = { name?: string; $metadata?: { httpStatusCode?: number } };

function statusOf(error: unknown): number | undefined {
	return (error as AwsError)?.$metadata?.httpStatusCode;
}

function isNotFound(error: unknown): boolean {
	const name = (error as AwsError)?.name;
	return statusOf(error) === 404 || name === "NotFound" || name === "NoSuchKey";
}

function s3Failure(error: unknown): ServiceResult<never, StorageError> {
	if (statusOf(error) === 403) {
		return failure(
			"ACCESS_DENIED",
			error instanceof Error ? error.message : String(error),
		);
	}
	return unknownFailure(error);
}

function contentDisposition(downloadFilename: string): string {
	return `attachment; filename="${downloadFilename.replace(/"/g, "")}"`;
}

/**
 * An S3 store. Presigned downloads and uncapped uploads are signed URLs; a
 * capped upload becomes a POST form, the only presigned shape that can enforce a
 * size limit (`content-length-range`) — and the framework always injects a
 * `maxSizeBytes`, so service-issued uploads are POST forms.
 *
 * ```ts
 * const provider = createS3Storage({
 *   bucket: "my-uploads",
 *   client: new S3Client({ region: "us-east-1" }),
 * });
 * ```
 */
export function createS3Storage(options: S3StorageOptions): StorageProvider {
	const { bucket, client = new S3Client({}) } = options;

	const presignedPost = async (
		key: string,
		ttlSeconds: number,
		maxSizeBytes: number,
		contentType?: string,
	): Promise<PresignedUpload> => {
		const { url, fields } = await createPresignedPost(client, {
			Bucket: bucket,
			Key: key,
			Expires: ttlSeconds,
			Conditions: [["content-length-range", 0, maxSizeBytes]],
			// Every field is also signed into the policy, pinning the content type.
			Fields: contentType ? { "Content-Type": contentType } : undefined,
		});
		return { method: "POST", url, fields };
	};

	const presignedPut = async (
		key: string,
		ttlSeconds: number,
		contentType?: string,
	): Promise<PresignedUpload> => {
		const command = new PutObjectCommand({
			Bucket: bucket,
			Key: key,
			ContentType: contentType,
		});
		// The SDK checksums the (absent) body and the presigner hoists that into the
		// URL, where no real upload can ever match it. Drop the headers after the
		// checksum middleware has run (`priority: "low"`) but before signing.
		command.middlewareStack.add(
			(next) => (args) => {
				const headers = (args.request as { headers?: Record<string, string> })
					.headers;
				for (const header of Object.keys(headers ?? {})) {
					if (/^x-amz-(checksum-|sdk-checksum-algorithm)/i.test(header)) {
						delete headers?.[header];
					}
				}
				return next(args);
			},
			{ step: "build", priority: "low", name: "stripPresignedChecksum" },
		);
		const url = await getSignedUrl(client, command, { expiresIn: ttlSeconds });
		return {
			method: "PUT",
			url,
			...(contentType ? { headers: { "content-type": contentType } } : {}),
		};
	};

	return {
		generatePresignedUploadUrl: async ({
			key,
			contentType,
			maxSizeBytes,
			ttlSeconds,
		}) => {
			try {
				const ttl =
					ttlSeconds ?? DEFAULT_UPLOAD_CONSTRAINTS.uploadUrlTtlSeconds;
				return success(
					maxSizeBytes === undefined
						? await presignedPut(key, ttl, contentType)
						: await presignedPost(key, ttl, maxSizeBytes, contentType),
				);
			} catch (error) {
				return s3Failure(error);
			}
		},

		generatePresignedDownloadUrl: async ({
			key,
			downloadFilename,
			ttlSeconds,
		}) => {
			try {
				const url = await getSignedUrl(
					client,
					new GetObjectCommand({
						Bucket: bucket,
						Key: key,
						ResponseContentDisposition: downloadFilename
							? contentDisposition(downloadFilename)
							: undefined,
					}),
					{
						expiresIn:
							ttlSeconds ?? DEFAULT_UPLOAD_CONSTRAINTS.downloadUrlTtlSeconds,
					},
				);
				return success({ url });
			} catch (error) {
				return s3Failure(error);
			}
		},

		put: async ({ key, body, contentType }) => {
			try {
				const params = {
					Bucket: bucket,
					Key: key,
					Body: body,
					ContentType: contentType,
				};
				// A stream has no length to sign, so upload it in parts rather than
				// buffering it to measure it.
				if (body instanceof Uint8Array) {
					await client.send(new PutObjectCommand(params));
				} else {
					await new Upload({ client, params, leavePartsOnError: false }).done();
				}
				return success();
			} catch (error) {
				return s3Failure(error);
			}
		},

		get: async ({ key }): Promise<ServiceResult<GetResult, StorageError>> => {
			try {
				const response = await client.send(
					new GetObjectCommand({ Bucket: bucket, Key: key }),
				);
				if (!response.Body) return success(null);
				return success({
					body: response.Body.transformToWebStream(),
					contentType: response.ContentType,
					size: response.ContentLength ?? 0,
				});
			} catch (error) {
				return isNotFound(error) ? success(null) : s3Failure(error);
			}
		},

		head: async ({ key }): Promise<ServiceResult<HeadResult, StorageError>> => {
			try {
				const response = await client.send(
					new HeadObjectCommand({ Bucket: bucket, Key: key }),
				);
				return success({
					size: response.ContentLength ?? 0,
					contentType: response.ContentType,
				});
			} catch (error) {
				return isNotFound(error) ? success(null) : s3Failure(error);
			}
		},

		delete: async ({ key }) => {
			try {
				await client.send(
					new DeleteObjectCommand({ Bucket: bucket, Key: key }),
				);
				return success();
			} catch (error) {
				return s3Failure(error);
			}
		},

		list: async ({ prefix, limit, cursor }) => {
			try {
				const response = await client.send(
					new ListObjectsV2Command({
						Bucket: bucket,
						Prefix: prefix,
						MaxKeys: limit,
						ContinuationToken: cursor,
					}),
				);
				return success({
					keys: (response.Contents ?? [])
						.map((object) => object.Key)
						.filter((key): key is string => Boolean(key)),
					cursor: response.NextContinuationToken,
				});
			} catch (error) {
				return s3Failure(error);
			}
		},
	};
}
