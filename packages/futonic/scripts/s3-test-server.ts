/**
 * Runs a throwaway Garage (S3-compatible) server for the storage integration
 * tests: `bun run scripts/s3-test-server.ts up | down`. Needs docker or podman.
 *
 * The config is baked into a derived image rather than bind-mounted, so it works
 * regardless of which host paths the container runtime's VM can see.
 */

import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { $ } from "bun";

const IMAGE = "docker.io/dxflrs/garage:v1.0.1";
const NAME = "futonic-garage-test";
export const S3_TEST_ENV = {
	S3_TEST_ENDPOINT: "http://127.0.0.1:3900",
	S3_TEST_REGION: "garage",
	S3_TEST_BUCKET: "futonic-test",
	S3_TEST_ACCESS_KEY_ID: "GK000000000000000000000001",
	S3_TEST_SECRET_ACCESS_KEY: `${"0".repeat(63)}2`,
};

const GARAGE_TOML = `metadata_dir = "/var/lib/garage/meta"
data_dir = "/var/lib/garage/data"
db_engine = "sqlite"
replication_factor = 1

rpc_bind_addr = "[::]:3901"
rpc_public_addr = "127.0.0.1:3901"
rpc_secret = "${"0".repeat(63)}1"

[s3_api]
s3_region = "${S3_TEST_ENV.S3_TEST_REGION}"
api_bind_addr = "[::]:3900"
root_domain = ".s3.garage.localhost"

[admin]
api_bind_addr = "[::]:3903"
admin_token = "test-admin-token"
`;

async function containerRuntime(): Promise<string> {
	for (const runtime of ["docker", "podman"]) {
		const { exitCode } = await $`${runtime} info`.quiet().nothrow();
		if (exitCode === 0) return runtime;
	}
	throw new Error("needs a running docker or podman");
}

async function up(runtime: string) {
	const context = await mkdtemp(join(tmpdir(), "futonic-garage-"));
	await writeFile(join(context, "garage.toml"), GARAGE_TOML);
	await writeFile(
		join(context, "Containerfile"),
		`FROM ${IMAGE}\nCOPY garage.toml /etc/garage.toml\n`,
	);
	await $`${runtime} build -q -t ${NAME} -f ${join(context, "Containerfile")} ${context}`.quiet();
	await $`${runtime} rm -f ${NAME}`.quiet().nothrow();
	await $`${runtime} run -d --name ${NAME} -p 3900:3900 -p 3903:3903 ${NAME}`.quiet();

	const garage = (...args: string[]) =>
		$`${runtime} exec ${NAME} /garage ${args}`.quiet().nothrow();
	for (let attempt = 0; ; attempt++) {
		if ((await garage("status")).exitCode === 0) break;
		if (attempt >= 30) throw new Error("garage did not become ready");
		await Bun.sleep(500);
	}

	const nodeId = (await garage("node", "id", "-q")).stdout
		.toString()
		.trim()
		.split("@")[0];
	if (!nodeId) throw new Error("could not read the garage node id");
	await garage("layout", "assign", "-z", "dc1", "-c", "1G", nodeId);
	await garage("layout", "apply", "--version", "1");
	await garage(
		"key",
		"import",
		"--yes",
		"-n",
		NAME,
		S3_TEST_ENV.S3_TEST_ACCESS_KEY_ID,
		S3_TEST_ENV.S3_TEST_SECRET_ACCESS_KEY,
	);
	await garage("bucket", "create", S3_TEST_ENV.S3_TEST_BUCKET);
	await garage(
		"bucket",
		"allow",
		"--read",
		"--write",
		"--owner",
		S3_TEST_ENV.S3_TEST_BUCKET,
		"--key",
		S3_TEST_ENV.S3_TEST_ACCESS_KEY_ID,
	);

	console.log(`[garage] ready on ${S3_TEST_ENV.S3_TEST_ENDPOINT}`);
	for (const [key, value] of Object.entries(S3_TEST_ENV)) {
		console.log(`export ${key}=${value}`);
	}
}

const command = process.argv[2] ?? "up";
const runtime = await containerRuntime();
if (command === "up") {
	await up(runtime);
} else if (command === "down") {
	await $`${runtime} rm -f ${NAME}`.quiet().nothrow();
	console.log("[garage] removed");
} else {
	throw new Error(`unknown command: ${command}`);
}
