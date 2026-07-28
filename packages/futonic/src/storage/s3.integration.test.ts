/**
 * End-to-end checks against a real S3 implementation. Skipped unless
 * `S3_TEST_ENDPOINT` is set — `bun run test:s3` starts a local Garage and runs
 * them; the same env vars can point at any other S3-compatible bucket.
 */

import { describe, expect, test } from "bun:test";
import { S3Client } from "@aws-sdk/client-s3";
import { resolveConstraints, withConstraints } from "./index";
import { createS3Storage } from "./s3";

const endpoint = process.env.S3_TEST_ENDPOINT;
const bucket = process.env.S3_TEST_BUCKET ?? "futonic-test";

const store = createS3Storage({
	bucket,
	client: new S3Client({
		endpoint,
		region: process.env.S3_TEST_REGION ?? "garage",
		forcePathStyle: true,
		// Defaults are the fixed credentials `scripts/s3-test-server.ts` provisions.
		credentials: {
			accessKeyId:
				process.env.S3_TEST_ACCESS_KEY_ID ?? "GK000000000000000000000001",
			secretAccessKey:
				process.env.S3_TEST_SECRET_ACCESS_KEY ?? `${"0".repeat(63)}2`,
		},
	}),
});

const bytes = (text: string) => new TextEncoder().encode(text);
const prefix = `it-${process.pid}`;
const key = (name: string) => `${prefix}/${name}`;

const postForm = (
	fields: Record<string, string>,
	body: string,
	contentType: string,
) => {
	const form = new FormData();
	for (const [name, value] of Object.entries(fields)) form.append(name, value);
	form.append("file", new Blob([body], { type: contentType }));
	return form;
};

describe.skipIf(!endpoint)("S3 storage against a live bucket", () => {
	test("round-trips put/get/head/delete", async () => {
		expect(
			(
				await store.put({
					key: key("a.txt"),
					body: bytes("hello"),
					contentType: "text/plain",
				})
			).error,
		).toBeNull();

		const got = await store.get({ key: key("a.txt") });
		expect(got.error).toBeNull();
		expect(got.data?.contentType).toBe("text/plain");
		expect(got.data?.size).toBe(5);
		expect(await new Response(got.data!.body).text()).toBe("hello");

		expect((await store.head({ key: key("a.txt") })).data).toEqual({
			size: 5,
			contentType: "text/plain",
		});
		expect((await store.head({ key: key("absent") })).data).toBeNull();
		expect((await store.get({ key: key("absent") })).data).toBeNull();

		expect((await store.delete({ key: key("a.txt") })).error).toBeNull();
		expect((await store.get({ key: key("a.txt") })).data).toBeNull();
	});

	test("streams a body past the multipart part size without buffering", async () => {
		const chunk = new Uint8Array(1024 * 1024).fill(65);
		const chunks = 6;
		let sent = 0;
		const body = new ReadableStream<Uint8Array>({
			pull(controller) {
				if (sent++ >= chunks) return controller.close();
				controller.enqueue(chunk);
			},
		});

		expect(
			(
				await store.put({
					key: key("big.bin"),
					body,
					contentType: "text/plain",
				})
			).error,
		).toBeNull();
		expect((await store.head({ key: key("big.bin") })).data).toEqual({
			size: chunks * chunk.byteLength,
			contentType: "text/plain",
		});
	});

	test("a capped stream aborts mid-upload and leaves nothing behind", async () => {
		const capped = withConstraints(
			store,
			resolveConstraints({ maxSizeBytes: 1024 }),
		);
		const chunk = new Uint8Array(1024 * 1024).fill(65);
		let sent = 0;
		const body = new ReadableStream<Uint8Array>({
			pull(controller) {
				if (sent++ >= 6) return controller.close();
				controller.enqueue(chunk);
			},
		});

		expect((await capped.put({ key: key("capped.bin"), body })).error).toBe(
			"TOO_LARGE",
		);
		expect((await store.head({ key: key("capped.bin") })).data).toBeNull();
	});

	test("lists a prefix and pages with the returned cursor", async () => {
		for (const name of ["p/1", "p/2", "p/3"]) {
			await store.put({ key: key(name), body: bytes(name) });
		}

		const first = await store.list({ prefix: `${prefix}/p/`, limit: 2 });
		expect(first.data?.keys).toEqual([key("p/1"), key("p/2")]);
		expect(first.data?.cursor).toBeTruthy();

		const second = await store.list({
			prefix: `${prefix}/p/`,
			limit: 2,
			cursor: first.data?.cursor,
		});
		expect(second.data?.keys).toEqual([key("p/3")]);
		expect(second.data?.cursor).toBeUndefined();
	});

	test("a presigned PUT url uploads, a presigned GET url downloads", async () => {
		const upload = await store.generatePresignedUploadUrl({
			key: key("put.txt"),
			contentType: "text/plain",
			ttlSeconds: 60,
		});
		if (upload.data?.method !== "PUT") throw new Error("expected a PUT url");

		const uploaded = await fetch(upload.data.url, {
			method: "PUT",
			headers: upload.data.headers,
			body: "via presigned put",
		});
		expect(uploaded.status).toBe(200);

		const download = await store.generatePresignedDownloadUrl({
			key: key("put.txt"),
			downloadFilename: "renamed.txt",
			ttlSeconds: 60,
		});
		const downloaded = await fetch(download.data!.url);
		expect(downloaded.status).toBe(200);
		expect(downloaded.headers.get("content-disposition")).toBe(
			'attachment; filename="renamed.txt"',
		);
		expect(await downloaded.text()).toBe("via presigned put");
	});

	test("a capped POST form uploads under the limit and rejects over it", async () => {
		const upload = await store.generatePresignedUploadUrl({
			key: key("post.txt"),
			contentType: "text/plain",
			maxSizeBytes: 20,
			ttlSeconds: 60,
		});
		if (upload.data?.method !== "POST") throw new Error("expected a POST form");

		const accepted = await fetch(upload.data.url, {
			method: "POST",
			body: postForm(upload.data.fields, "small", "text/plain"),
		});
		expect(accepted.status).toBeLessThan(300);
		expect(
			await new Response(
				(await store.get({ key: key("post.txt") })).data!.body,
			).text(),
		).toBe("small");

		const rejected = await fetch(upload.data.url, {
			method: "POST",
			body: postForm(upload.data.fields, "x".repeat(500), "text/plain"),
		});
		expect(rejected.status).toBeGreaterThanOrEqual(400);
	});
});
