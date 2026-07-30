/**
 * End-to-end checks against a real S3 implementation, driving the same stack a
 * host gets: files-sdk's `s3` adapter under futonic's shim and per-service
 * prefix. Skipped unless `S3_TEST_ENDPOINT` is set — `bun run test:s3` starts a
 * local Garage and runs them; the same env vars can point at any other
 * S3-compatible bucket.
 */

import { describe, expect, test } from "bun:test";
import { Files } from "files-sdk";
import { s3 } from "files-sdk/s3";
import {
	DEFAULT_MAX_UPLOAD_BYTES,
	shimSignedUrls,
	withUploadSizeCeiling,
} from "./presigned-shim";

const endpoint = process.env.S3_TEST_ENDPOINT;

// Defaults are the fixed credentials `scripts/s3-test-server.ts` provisions.
const adapter = s3({
	bucket: process.env.S3_TEST_BUCKET ?? "futonic-test",
	region: process.env.S3_TEST_REGION ?? "garage",
	endpoint: endpoint ?? "http://127.0.0.1:3900",
	forcePathStyle: true,
	credentials: {
		accessKeyId:
			process.env.S3_TEST_ACCESS_KEY_ID ?? "GK000000000000000000000001",
		secretAccessKey:
			process.env.S3_TEST_SECRET_ACCESS_KEY ?? `${"0".repeat(63)}2`,
	},
});

const prefix = `it-${process.pid}`;
const files = new Files({ adapter, prefix });
const key = (name: string) => `${prefix}/${name}`;

const postForm = (fields: Record<string, string>, body: string) => {
	const form = new FormData();
	for (const [name, value] of Object.entries(fields)) form.append(name, value);
	form.append("file", new Blob([body], { type: "text/plain" }));
	return form;
};

describe.skipIf(!endpoint)("files-sdk S3 against a live bucket", () => {
	test("a signing adapter needs no transfer route", () => {
		expect(adapter.signedUrl?.supported).toBe(true);
		const shimmed = shimSignedUrls(adapter, {
			signingKey: "k",
			baseUrl: "http://x",
		});
		expect(shimmed.adapter).toBe(adapter);
		expect(shimmed.transferRoute).toBeUndefined();
	});

	test("round-trips upload/download/head/exists/copy/delete", async () => {
		await files.upload("a.txt", "hello", { contentType: "text/plain" });

		const got = await files.download("a.txt");
		expect(got.key).toBe("a.txt");
		expect(got.size).toBe(5);
		expect(got.type).toBe("text/plain");
		expect(await got.text()).toBe("hello");

		expect((await files.head("a.txt")).size).toBe(5);
		expect(await files.exists("a.txt")).toBe(true);
		expect(await files.exists("absent")).toBe(false);

		await files.copy("a.txt", "b.txt");
		expect(await (await files.download("b.txt")).text()).toBe("hello");

		await files.delete("a.txt");
		expect(await files.exists("a.txt")).toBe(false);
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

		await files.upload("big.bin", body, { contentType: "text/plain" });
		expect((await files.head("big.bin")).size).toBe(chunks * chunk.byteLength);
	});

	test("lists a prefix and pages with the returned cursor", async () => {
		for (const name of ["p/1", "p/2", "p/3"]) {
			await files.upload(name, name);
		}

		const first = await files.list({ prefix: "p/", limit: 2 });
		expect(first.items.map((file) => file.key)).toEqual(["p/1", "p/2"]);
		expect(first.cursor).toBeTruthy();

		const second = await files.list({
			prefix: "p/",
			limit: 2,
			cursor: first.cursor,
		});
		expect(second.items.map((file) => file.key)).toEqual(["p/3"]);
		expect(second.cursor).toBeUndefined();
	});

	test("a signed download url fetches, with a forced disposition", async () => {
		await files.upload("dl.txt", "downloaded", { contentType: "text/plain" });
		const url = await files.url("dl.txt", {
			expiresIn: 60,
			responseContentDisposition: 'attachment; filename="renamed.txt"',
		});

		const response = await fetch(url);
		expect(response.status).toBe(200);
		expect(response.headers.get("content-disposition")).toBe(
			'attachment; filename="renamed.txt"',
		);
		expect(await response.text()).toBe("downloaded");
	});

	test("a capped upload is a POST form that enforces the size", async () => {
		const upload = await files.signedUploadUrl("post.txt", {
			expiresIn: 60,
			contentType: "text/plain",
			maxSize: 20,
			minSize: 0,
		});
		if (upload.method !== "POST") throw new Error("expected a POST form");
		// The key is prefixed by the Files instance, not by the caller.
		expect(upload.fields.key).toBe(key("post.txt"));

		const accepted = await fetch(upload.url, {
			method: "POST",
			body: postForm(upload.fields, "small"),
		});
		expect(accepted.status).toBeLessThan(300);
		expect(await (await files.download("post.txt")).text()).toBe("small");

		const rejected = await fetch(upload.url, {
			method: "POST",
			body: postForm(upload.fields, "x".repeat(500)),
		});
		expect(rejected.status).toBeGreaterThanOrEqual(400);
	});

	test("the injected ceiling keeps an uncapped presign on the working path", async () => {
		const capped = new Files({
			adapter: withUploadSizeCeiling(adapter),
			prefix,
		});
		const upload = await capped.signedUploadUrl("ceiling.txt", {
			expiresIn: 60,
			contentType: "text/plain",
		});
		// A POST form, not the PUT url whose signed checksum no upload can match.
		if (upload.method !== "POST") throw new Error("expected a POST form");
		expect(JSON.parse(atob(upload.fields.Policy ?? "")).conditions).toEqual(
			expect.arrayContaining([
				["content-length-range", 0, DEFAULT_MAX_UPLOAD_BYTES],
			]),
		);

		const uploaded = await fetch(upload.url, {
			method: "POST",
			body: postForm(upload.fields, "real bytes"),
		});
		expect(uploaded.status).toBeLessThan(300);
		expect(await (await files.download("ceiling.txt")).text()).toBe(
			"real bytes",
		);

		// The ceiling must not introduce a floor the caller never asked for.
		const empty = await fetch(upload.url, {
			method: "POST",
			body: postForm(upload.fields, ""),
		});
		expect(empty.status).toBeLessThan(300);
	});

	test("minSize defaults to 1, so an empty upload is refused", async () => {
		const upload = await files.signedUploadUrl("empty.txt", {
			expiresIn: 60,
			contentType: "text/plain",
			maxSize: 20,
		});
		if (upload.method !== "POST") throw new Error("expected a POST form");
		expect(JSON.parse(atob(upload.fields.Policy ?? "")).conditions).toEqual(
			expect.arrayContaining([["content-length-range", 1, 20]]),
		);

		const rejected = await fetch(upload.url, {
			method: "POST",
			body: postForm(upload.fields, ""),
		});
		expect(rejected.status).toBeGreaterThanOrEqual(400);
	});

	// files-sdk 2.2.1 signs an uncapped PUT without stripping the AWS SDK's
	// default flexible checksum, so the URL carries a CRC32 of the *absent* body
	// and any real upload is rejected with InvalidDigest. Passing a `maxSize`
	// avoids it by taking the POST-form path. Drop the `.failing` once upstream
	// fixes it — this test then guards against a regression.
	test.failing("an uncapped presigned PUT uploads", async () => {
		const upload = await files.signedUploadUrl("put.txt", {
			expiresIn: 60,
			contentType: "text/plain",
		});
		if (upload.method !== "PUT") throw new Error("expected a PUT url");
		expect(
			[...new URL(upload.url).searchParams.keys()].filter((param) =>
				/^x-amz-(checksum-|sdk-checksum-algorithm)/i.test(param),
			),
		).toEqual([]);

		const uploaded = await fetch(upload.url, {
			method: "PUT",
			headers: upload.headers,
			body: "via presigned put",
		});
		expect(uploaded.status).toBe(200);
	});
});
