/**
 * A files-sdk adapter that keeps blobs in the host's own database — the
 * zero-infrastructure default. Each service gets its own table (see
 * `storageTableName`), created on first use so it works without migrations.
 * Bodies round-trip through the database, so this is for development and small
 * objects; point a real provider at production.
 */

import {
	type Body,
	FilesError,
	type ListOptions,
	type ListResult,
	type SignUploadOptions,
	type SignedUpload,
	type StoredFile,
	type UploadOptions,
	type UploadResult,
	type UrlOptions,
} from "files-sdk";
import { Kysely, sql } from "kysely";
import {
	type DatabaseConnection,
	type DatabaseProvider,
	createDialect,
} from "../kysely";
import type { FutonicStorageAdapter } from "./types";

const DEFAULT_CONTENT_TYPE = "application/octet-stream";
const MAX_PAGE_SIZE = 1000;
const LIKE_ESCAPE_CHAR = "#";

type StorageRow = {
	key: string;
	content_type: string | null;
	size: number;
	data: Uint8Array;
	created_at: string;
};
/** Keyed by table name, which is per service and only known at runtime. */
type StorageDB = Record<string, StorageRow>;

/** Escape LIKE wildcards so a prefix matches literally (`_`/`%` are common in keys). */
function escapeLikePrefix(prefix: string): string {
	return prefix.replace(/[#%_]/g, (c) => `${LIKE_ESCAPE_CHAR}${c}`);
}

function notFound(key: string): FilesError {
	return new FilesError("NotFound", `no object stored at "${key}"`);
}

function storedFile(
	row: Omit<StorageRow, "data">,
	load: () => Promise<Uint8Array>,
): StoredFile {
	const type = row.content_type ?? DEFAULT_CONTENT_TYPE;
	const lastModified = Date.parse(row.created_at);
	return {
		key: row.key,
		name: row.key.split("/").pop() ?? row.key,
		size: row.size,
		type,
		...(Number.isNaN(lastModified) ? {} : { lastModified }),
		arrayBuffer: async () => {
			const bytes = await load();
			return bytes.buffer.slice(
				bytes.byteOffset,
				bytes.byteOffset + bytes.byteLength,
			) as ArrayBuffer;
		},
		text: async () => new TextDecoder().decode(await load()),
		blob: async () => new Blob([(await load()) as BlobPart], { type }),
		stream: () =>
			new ReadableStream<Uint8Array>({
				async start(controller) {
					controller.enqueue(await load());
					controller.close();
				},
			}),
	};
}

export function databaseAdapter({
	connection,
	provider,
	table,
}: {
	connection: DatabaseConnection;
	provider: DatabaseProvider;
	/** The service's own storage table — see `storageTableName`. */
	table: string;
}): FutonicStorageAdapter {
	const db = new Kysely<StorageDB>({
		dialect: createDialect(connection, provider),
	});

	let ready: Promise<void> | null = null;
	const ensure = (): Promise<void> => {
		if (!ready) {
			const blobType =
				provider === "pg"
					? sql`bytea`
					: provider === "mysql"
						? sql`longblob`
						: sql`blob`;
			ready = db.schema
				.createTable(table)
				.ifNotExists()
				.addColumn("key", "varchar(255)", (c) => c.primaryKey().notNull())
				.addColumn("content_type", "varchar(255)")
				.addColumn("size", "integer", (c) => c.notNull())
				.addColumn("data", blobType, (c) => c.notNull())
				.addColumn("created_at", "varchar(64)", (c) => c.notNull())
				.execute()
				.then(() => undefined)
				.catch((error) => {
					ready = null;
					throw error;
				});
		}
		return ready;
	};

	const metadataOf = async (
		key: string,
	): Promise<Omit<StorageRow, "data"> | undefined> => {
		await ensure();
		return db
			.selectFrom(table)
			.select(["key", "content_type", "size", "created_at"])
			.where("key", "=", key)
			.executeTakeFirst();
	};

	const bytesOf = async (key: string): Promise<Uint8Array> => {
		await ensure();
		const row = await db
			.selectFrom(table)
			.select("data")
			.where("key", "=", key)
			.executeTakeFirst();
		if (!row) throw notFound(key);
		return new Uint8Array(row.data);
	};

	const write = async (
		key: string,
		bytes: Uint8Array,
		contentType: string | null,
	): Promise<string> => {
		const createdAt = new Date().toISOString();
		// Delete-then-insert rather than an upsert, whose syntax differs per dialect.
		await db.deleteFrom(table).where("key", "=", key).execute();
		await db
			.insertInto(table)
			.values({
				key,
				content_type: contentType,
				size: bytes.byteLength,
				data: Buffer.from(bytes),
				created_at: createdAt,
			})
			.execute();
		return createdAt;
	};

	const cannotSign = (operation: string): FilesError =>
		new FilesError(
			"Provider",
			`the database adapter cannot sign URLs; futonic presigns ${operation} against its own transfer route once storage.signingKey and storage.baseUrl are set`,
			undefined,
			{ permanent: true },
		);

	return {
		name: "database",
		raw: db,
		signedUrl: { supported: false },

		upload: async (
			key: string,
			body: Body,
			opts?: UploadOptions,
		): Promise<UploadResult> => {
			await ensure();
			const bytes = new Uint8Array(
				await new Response(body as BodyInit).arrayBuffer(),
			);
			const contentType =
				opts?.contentType ?? (body instanceof Blob ? body.type : "") ?? "";
			const createdAt = await write(key, bytes, contentType || null);
			return {
				key,
				size: bytes.byteLength,
				contentType: contentType || DEFAULT_CONTENT_TYPE,
				lastModified: Date.parse(createdAt),
			};
		},

		download: async (key: string): Promise<StoredFile> => {
			const row = await metadataOf(key);
			if (!row) throw notFound(key);
			// Read once up front so repeated accessors don't re-query.
			const bytes = await bytesOf(key);
			return storedFile(row, async () => bytes);
		},

		head: async (key: string): Promise<StoredFile> => {
			const row = await metadataOf(key);
			if (!row) throw notFound(key);
			return storedFile(row, () => bytesOf(key));
		},

		exists: async (key: string): Promise<boolean> =>
			(await metadataOf(key)) !== undefined,

		delete: async (key: string): Promise<void> => {
			await ensure();
			await db.deleteFrom(table).where("key", "=", key).execute();
		},

		copy: async (from: string, to: string): Promise<void> => {
			await ensure();
			const row = await db
				.selectFrom(table)
				.selectAll()
				.where("key", "=", from)
				.executeTakeFirst();
			if (!row) throw notFound(from);
			await write(to, new Uint8Array(row.data), row.content_type);
		},

		list: async (opts?: ListOptions): Promise<ListResult> => {
			await ensure();
			const limit = Math.min(opts?.limit ?? MAX_PAGE_SIZE, MAX_PAGE_SIZE);
			let query = db
				.selectFrom(table)
				.select(["key", "content_type", "size", "created_at"])
				.orderBy("key");
			if (opts?.prefix) {
				query = query.where(
					sql<boolean>`${sql.ref("key")} like ${`${escapeLikePrefix(opts.prefix)}%`} escape '#'`,
				);
			}
			if (opts?.cursor) query = query.where("key", ">", opts.cursor);
			const rows = await query.limit(limit + 1).execute();
			const page = rows.slice(0, limit);
			return {
				items: page.map((row) => storedFile(row, () => bytesOf(row.key))),
				...(rows.length > limit ? { cursor: page[page.length - 1]?.key } : {}),
			};
		},

		url: (_key: string, _opts?: UrlOptions): Promise<string> => {
			throw cannotSign("downloads");
		},

		signedUploadUrl: (
			_key: string,
			_opts: SignUploadOptions,
		): Promise<SignedUpload> => {
			throw cannotSign("uploads");
		},
	};
}
