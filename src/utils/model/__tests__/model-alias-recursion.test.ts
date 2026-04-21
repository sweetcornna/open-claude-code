import { describe, expect, test } from "bun:test";
import { isModelAlias } from "../aliases";

/**
 * Replicate the guard used in getDefault*Model to verify it catches
 * all alias forms that would cause recursion.
 */
function isAliasOrAliasWithSuffix(value: string): boolean {
  const base = value.replace(/\[1m\]$/i, "").trim();
  return isModelAlias(base);
}

describe("isAliasOrAliasWithSuffix", () => {
  test("detects bare 'opus' alias", () => {
    expect(isAliasOrAliasWithSuffix("opus")).toBe(true);
  });

  test("detects 'opus[1m]' alias", () => {
    expect(isAliasOrAliasWithSuffix("opus[1m]")).toBe(true);
  });

  test("detects 'sonnet' alias", () => {
    expect(isAliasOrAliasWithSuffix("sonnet")).toBe(true);
  });

  test("detects 'sonnet[1m]' alias", () => {
    expect(isAliasOrAliasWithSuffix("sonnet[1m]")).toBe(true);
  });

  test("detects 'haiku' alias", () => {
    expect(isAliasOrAliasWithSuffix("haiku")).toBe(true);
  });

  test("detects 'haiku[1m]' alias", () => {
    expect(isAliasOrAliasWithSuffix("haiku[1m]")).toBe(true);
  });

  test("detects 'opusplan' alias", () => {
    expect(isAliasOrAliasWithSuffix("opusplan")).toBe(true);
  });

  test("detects 'best' alias", () => {
    expect(isAliasOrAliasWithSuffix("best")).toBe(true);
  });

  test("passes through concrete model IDs", () => {
    expect(isAliasOrAliasWithSuffix("claude-opus-4-6")).toBe(false);
    expect(isAliasOrAliasWithSuffix("claude-sonnet-4-6")).toBe(false);
    expect(isAliasOrAliasWithSuffix("claude-haiku-4-5-20251001")).toBe(false);
  });

  test("passes through concrete model IDs with [1m] suffix", () => {
    expect(isAliasOrAliasWithSuffix("claude-opus-4-6[1m]")).toBe(false);
    expect(isAliasOrAliasWithSuffix("claude-sonnet-4-6[1m]")).toBe(false);
  });

  test("passes through 3P provider model IDs", () => {
    expect(
      isAliasOrAliasWithSuffix("us.anthropic.claude-opus-4-6-v1:0"),
    ).toBe(false);
    expect(isAliasOrAliasWithSuffix("claude-opus-4-6@20251001")).toBe(false);
  });

  test("passes through arbitrary custom model names", () => {
    expect(isAliasOrAliasWithSuffix("my-custom-model")).toBe(false);
    expect(isAliasOrAliasWithSuffix("gpt-4o")).toBe(false);
  });

  test("handles whitespace around alias", () => {
    expect(isAliasOrAliasWithSuffix("  opus  ")).toBe(true);
    expect(isAliasOrAliasWithSuffix("  opus[1m]  ")).toBe(true);
  });

  test("handles case insensitivity of [1m] suffix", () => {
    expect(isAliasOrAliasWithSuffix("opus[1M]")).toBe(true);
    expect(isAliasOrAliasWithSuffix("sonnet[1M]")).toBe(true);
  });
});
