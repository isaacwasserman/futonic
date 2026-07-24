import { expect, test } from "bun:test";
import { failure, success, unknownFailure } from "./result";

test("success wraps data with a null error", () => {
	expect(success({ id: "a" })).toEqual({ data: { id: "a" }, error: null });
});

test("success with no argument yields undefined data", () => {
	expect(success()).toEqual({ data: undefined, error: null });
});

test("failure carries a typed error code and message", () => {
	expect(failure("NOT_FOUND", "missing")).toEqual({
		data: null,
		error: "NOT_FOUND",
		message: "missing",
	});
});

test("unknownFailure normalizes Error and non-Error values", () => {
	expect(unknownFailure(new Error("boom"))).toEqual({
		data: null,
		error: "UNKNOWN",
		message: "boom",
	});
	expect(unknownFailure("plain")).toEqual({
		data: null,
		error: "UNKNOWN",
		message: "plain",
	});
});
