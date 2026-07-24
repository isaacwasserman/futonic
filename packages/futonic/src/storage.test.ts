import { expect, test } from "bun:test";
import {
	type StorageProvider,
	createDatabaseStorage,
	resolveConstraints,
	withConstraints,
	withServiceKeyPrefix,
} from "./storage";
import { createSqliteConnection } from "./test-helpers";

// The published `createInMemoryStorage` uses `node:sqlite`, which the Bun test
// runtime lacks — so exercise the same `createDatabaseStorage` logic on a
// `bun:sqlite` connection instead.
const createInMemoryStorage = (options?: {
	owner?: string;
	signingKey?: string;
	baseUrl?: string;
}): StorageProvider =>
	createDatabaseStorage({
		connection: createSqliteConnection(),
		provider: "sqlite",
		owner: options?.owner ?? "default",
		signingKey: options?.signingKey,
		baseUrl: options?.baseUrl,
	});

const bytes = (s: string) => new TextEncoder().encode(s);
const readText = (stream: ReadableStream) => new Response(stream).text();

test("in-memory store round-trips put/get/head/delete/list", async () => {
	const store = createInMemoryStorage();

	expect(
		(
			await store.put({
				key: "a.txt",
				body: bytes("hello"),
				contentType: "text/plain",
			})
		).error,
	).toBeNull();

	const got = await store.get({ key: "a.txt" });
	expect(got.error).toBeNull();
	expect(got.data?.size).toBe(5);
	expect(got.data?.contentType).toBe("text/plain");
	expect(await readText(got.data!.body)).toBe("hello");

	const head = await store.head({ key: "a.txt" });
	expect(head.data).toEqual({ size: 5, contentType: "text/plain" });

	await store.put({ key: "b.txt", body: bytes("world") });
	const listed = await store.list({});
	expect(listed.data?.keys.sort()).toEqual(["a.txt", "b.txt"]);

	expect((await store.delete({ key: "a.txt" })).error).toBeNull();
	expect((await store.get({ key: "a.txt" })).data).toBeNull();
	expect((await store.head({ key: "missing" })).data).toBeNull();
});

test("list treats prefix wildcards (_ and %) literally", async () => {
	const store = createInMemoryStorage();
	await store.put({ key: "user_1/doc", body: bytes("mine") });
	await store.put({ key: "userX1/doc", body: bytes("theirs") });

	expect((await store.list({ prefix: "user_1/" })).data?.keys).toEqual([
		"user_1/doc",
	]);
});

test("the DB store scopes rows by owner in the shared table", async () => {
	const connection = createSqliteConnection();
	const a = createDatabaseStorage({
		connection,
		provider: "sqlite",
		owner: "a",
	});
	const b = createDatabaseStorage({
		connection,
		provider: "sqlite",
		owner: "b",
	});

	await a.put({ key: "shared", body: bytes("from-a") });
	await b.put({ key: "shared", body: bytes("from-b") });

	expect(await readText((await a.get({ key: "shared" })).data!.body)).toBe(
		"from-a",
	);
	expect(await readText((await b.get({ key: "shared" })).data!.body)).toBe(
		"from-b",
	);
	expect((await a.list({})).data?.keys).toEqual(["shared"]);
	expect((await b.list({})).data?.keys).toEqual(["shared"]);
});

test("withServiceKeyPrefix isolates services and un-prefixes list results", async () => {
	const shared = createInMemoryStorage();
	const svc1 = withServiceKeyPrefix(shared, "svc1");
	const svc2 = withServiceKeyPrefix(shared, "svc2");

	await svc1.put({ key: "doc", body: bytes("one") });
	await svc2.put({ key: "doc", body: bytes("two") });

	expect((await svc1.list({})).data?.keys).toEqual(["doc"]);
	expect(await readText((await svc1.get({ key: "doc" })).data!.body)).toBe(
		"one",
	);
	expect(await readText((await svc2.get({ key: "doc" })).data!.body)).toBe(
		"two",
	);
});

test("withServiceKeyPrefix blocks traversal and absolute keys", async () => {
	const svc = withServiceKeyPrefix(createInMemoryStorage(), "svc");
	expect((await svc.get({ key: "../secret" })).error).toBe("ACCESS_DENIED");
	expect((await svc.put({ key: "/etc/passwd", body: bytes("x") })).error).toBe(
		"ACCESS_DENIED",
	);
});

test("withConstraints rejects oversized bodies and disallowed content types", async () => {
	const store = withConstraints(
		createInMemoryStorage(),
		resolveConstraints({
			maxSizeBytes: 10,
			allowedContentTypes: ["text/plain"],
		}),
	);

	expect(
		(
			await store.put({
				key: "big",
				body: bytes("x".repeat(20)),
				contentType: "text/plain",
			})
		).error,
	).toBe("TOO_LARGE");
	expect(
		(
			await store.put({
				key: "img",
				body: bytes("x"),
				contentType: "image/png",
			})
		).error,
	).toBe("UNSUPPORTED_TYPE");
	expect(
		(
			await store.generatePresignedUploadUrl({
				key: "img",
				contentType: "image/png",
			})
		).error,
	).toBe("UNSUPPORTED_TYPE");
});

test("presign requires signingKey/baseUrl", async () => {
	const store = createInMemoryStorage();
	expect((await store.generatePresignedUploadUrl({ key: "a" })).error).toBe(
		"UNSUPPORTED",
	);
	expect(store.transferRoute).toBeUndefined();
});

test("transfer route uploads and downloads via signed tokens", async () => {
	const store = createInMemoryStorage({
		signingKey: "secret",
		baseUrl: "http://localhost/api/x",
	});
	const route = store.transferRoute;
	expect(route).toBeDefined();

	const upload = await store.generatePresignedUploadUrl({
		key: "file",
		ttlSeconds: 60,
	});
	expect(upload.data?.method).toBe("PUT");
	const put = await route!.handle(
		new Request((upload.data as { url: string }).url, {
			method: "PUT",
			body: bytes("payload"),
		}),
	);
	expect(put.status).toBe(204);

	const download = await store.generatePresignedDownloadUrl({
		key: "file",
		ttlSeconds: 60,
	});
	const get = await route!.handle(
		new Request(download.data!.url, { method: "GET" }),
	);
	expect(get.status).toBe(200);
	expect(await get.text()).toBe("payload");
});

test("transfer route rejects expired, tampered, and oversized uploads", async () => {
	const store = createInMemoryStorage({
		signingKey: "secret",
		baseUrl: "http://localhost/api/x",
	});
	const route = store.transferRoute!;

	const expired = await store.generatePresignedUploadUrl({
		key: "e",
		ttlSeconds: -10,
	});
	const expiredUrl = (expired.data as { url: string }).url;
	expect(
		(
			await route.handle(
				new Request(expiredUrl, { method: "PUT", body: bytes("x") }),
			)
		).status,
	).toBe(403);

	const tampered = `${expiredUrl.slice(0, -2)}zz`;
	expect(
		(
			await route.handle(
				new Request(tampered, { method: "PUT", body: bytes("x") }),
			)
		).status,
	).toBe(403);

	const capped = await store.generatePresignedUploadUrl({
		key: "c",
		maxSizeBytes: 4,
	});
	const cappedUrl = (capped.data as { url: string }).url;
	expect(
		(
			await route.handle(
				new Request(cappedUrl, { method: "PUT", body: bytes("toolong") }),
			)
		).status,
	).toBe(413);
});
