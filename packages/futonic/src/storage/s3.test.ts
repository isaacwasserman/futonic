import { expect, test } from "bun:test";
import { S3Client } from "@aws-sdk/client-s3";
import { type } from "arktype";
import { createFutonicServiceConstructor, defineService } from "../service";
import { createSqliteConnection } from "../test-helpers";
import { createS3Storage } from "./s3";

type Sent = { constructor: { name: string }; input: Record<string, unknown> };

function stubbedS3(respond: (command: Sent) => unknown = () => ({})): {
	client: S3Client;
	sent: Sent[];
} {
	const client = new S3Client({
		region: "us-east-1",
		credentials: { accessKeyId: "AKIAEXAMPLE", secretAccessKey: "secret" },
	});
	const sent: Sent[] = [];
	Object.assign(client, {
		send: async (command: Sent) => {
			sent.push(command);
			const response = respond(command);
			if (response instanceof Error) throw response;
			return response;
		},
	});
	return { client, sent };
}

const awsError = (name: string, status: number) =>
	Object.assign(new Error(name), {
		name,
		$metadata: { httpStatusCode: status },
	});

const decodePolicy = (policy: string) =>
	JSON.parse(
		new TextDecoder().decode(
			Uint8Array.from(atob(policy), (c) => c.charCodeAt(0)),
		),
	);

test("a capped presigned upload is a POST form carrying the size limit", async () => {
	const { client } = stubbedS3();
	const store = createS3Storage({ bucket: "my-bucket", client });

	const result = await store.generatePresignedUploadUrl({
		key: "svc/a.png",
		contentType: "image/png",
		maxSizeBytes: 1024,
		ttlSeconds: 60,
	});

	expect(result.error).toBeNull();
	if (result.data?.method !== "POST") throw new Error("expected a POST form");
	expect(result.data.url).toContain("my-bucket");
	expect(result.data.fields.key).toBe("svc/a.png");
	expect(result.data.fields["Content-Type"]).toBe("image/png");
	expect(result.data.fields["X-Amz-Signature"]).toBeTruthy();
	expect(decodePolicy(result.data.fields.Policy!).conditions).toEqual(
		expect.arrayContaining([
			["content-length-range", 0, 1024],
			{ "Content-Type": "image/png" },
		]),
	);
});

test("an uncapped presigned upload is a signed PUT url", async () => {
	const { client } = stubbedS3();
	const store = createS3Storage({ bucket: "my-bucket", client });

	const result = await store.generatePresignedUploadUrl({
		key: "svc/a.png",
		contentType: "image/png",
		ttlSeconds: 60,
	});

	if (result.data?.method !== "PUT") throw new Error("expected a PUT url");
	expect(result.data.url).toContain("X-Amz-Signature=");
	expect(result.data.url).toContain("X-Amz-Expires=60");
	expect(result.data.headers).toEqual({ "content-type": "image/png" });
});

test("presigned downloads sign a filename disposition", async () => {
	const { client } = stubbedS3();
	const store = createS3Storage({ bucket: "my-bucket", client });

	const result = await store.generatePresignedDownloadUrl({
		key: "svc/a.png",
		downloadFilename: 'in"voice.png',
		ttlSeconds: 30,
	});

	expect(result.error).toBeNull();
	const url = new URL(result.data!.url);
	expect(url.searchParams.get("response-content-disposition")).toBe(
		'attachment; filename="invoice.png"',
	);
	expect(url.searchParams.get("X-Amz-Expires")).toBe("30");
});

test("put/get/head/delete/list map onto S3 commands", async () => {
	const { client, sent } = stubbedS3((command) =>
		command.constructor.name === "GetObjectCommand"
			? {
					Body: { transformToWebStream: () => new Response("hi").body },
					ContentType: "text/plain",
					ContentLength: 2,
				}
			: command.constructor.name === "HeadObjectCommand"
				? { ContentLength: 2, ContentType: "text/plain" }
				: command.constructor.name === "ListObjectsV2Command"
					? {
							Contents: [{ Key: "svc/a.txt" }, {}],
							NextContinuationToken: "next-page",
						}
					: {},
	);
	const store = createS3Storage({ bucket: "my-bucket", client });

	expect(
		(
			await store.put({
				key: "svc/a.txt",
				body: new TextEncoder().encode("hi"),
				contentType: "text/plain",
			})
		).error,
	).toBeNull();
	expect(sent[0]?.input).toMatchObject({
		Bucket: "my-bucket",
		Key: "svc/a.txt",
		ContentType: "text/plain",
	});

	const got = await store.get({ key: "svc/a.txt" });
	expect(got.data?.size).toBe(2);
	expect(await new Response(got.data!.body).text()).toBe("hi");

	expect((await store.head({ key: "svc/a.txt" })).data).toEqual({
		size: 2,
		contentType: "text/plain",
	});
	expect((await store.delete({ key: "svc/a.txt" })).error).toBeNull();

	const listed = await store.list({
		prefix: "svc/",
		limit: 10,
		cursor: "page",
	});
	expect(listed.data).toEqual({ keys: ["svc/a.txt"], cursor: "next-page" });
	expect(sent[4]?.input).toMatchObject({
		Prefix: "svc/",
		MaxKeys: 10,
		ContinuationToken: "page",
	});
});

test("a service issues POST uploads scoped and capped by the framework", async () => {
	const { client, sent } = stubbedS3();
	const make = createFutonicServiceConstructor(
		defineService({
			id: "docs",
			dbSchema: {
				tables: {
					files: {
						name: "files",
						columns: { id: { type: "string", primaryKey: true } },
					},
				},
			},
			configSchema: type({}),
			storage: { constraints: { maxSizeBytes: 4096 } },
			endpoints: (defineEndpoint) => ({
				uploadUrl: defineEndpoint("/upload-url", { method: "POST" }, (ctx) =>
					ctx.context.serviceCtx.storage.generatePresignedUploadUrl({
						key: "a.png",
						contentType: "image/png",
					}),
				),
			}),
		}),
	);
	const svc = make({
		config: {},
		database: { connection: createSqliteConnection(), provider: "sqlite" },
		storage: { provider: createS3Storage({ bucket: "my-bucket", client }) },
	});

	const upload = await svc.endpoints.uploadUrl();
	if (upload.data?.method !== "POST") throw new Error("expected a POST form");
	expect(upload.data.fields.key).toBe("docs/a.png");
	expect(decodePolicy(upload.data.fields.Policy!).conditions).toEqual(
		expect.arrayContaining([["content-length-range", 0, 4096]]),
	);
	expect(sent).toEqual([]);
});

test("missing objects read as absent, denials as ACCESS_DENIED", async () => {
	const { client } = stubbedS3((command) =>
		command.constructor.name === "GetObjectCommand"
			? awsError("NoSuchKey", 404)
			: command.constructor.name === "HeadObjectCommand"
				? awsError("NotFound", 404)
				: awsError("AccessDenied", 403),
	);
	const store = createS3Storage({ bucket: "my-bucket", client });

	expect((await store.get({ key: "gone" })).data).toBeNull();
	expect((await store.get({ key: "gone" })).error).toBeNull();
	expect((await store.head({ key: "gone" })).data).toBeNull();
	expect((await store.list({})).error).toBe("ACCESS_DENIED");
});
