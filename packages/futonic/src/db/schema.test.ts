import { describe, expect, test } from "bun:test";
import { prefixTableName } from "./schema";

describe("prefixTableName", () => {
	test("prefixes table name with service id", () => {
		expect(prefixTableName("billing", "invoices")).toBe("billing_invoices");
	});
});
