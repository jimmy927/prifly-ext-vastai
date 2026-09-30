import { describe, expect, test } from "bun:test";
import { book } from "../leases";
import { type Asker, bookingLabel, labelsFor, targetOf } from "../vastlease";

const ME: Asker = { owner: "jimmy", session8: "0123abcd" };
const NOW = 1_800_000_000_000;

describe("vastlease labels", () => {
  test("book labels a name with the owner and the session", () => {
    expect(bookingLabel("lc-box1", ME)).toBe("jimmy/s-0123abcd/lc-box1");
  });

  test("a whole label in either form is taken as given", () => {
    expect(bookingLabel("jimmy/s-89abcdef/lc-box2", ME)).toBe("jimmy/s-89abcdef/lc-box2");
    expect(labelsFor("s-89abcdef/lc-box2", ME)).toEqual(["s-89abcdef/lc-box2"]);
  });

  test("refuses another owner's label, a name over 8 characters, and a name without a session", () => {
    expect(() => bookingLabel("anna/s-0123abcd/lc-box1", ME)).toThrow("anna's box");
    expect(() => bookingLabel("lc-box123", ME)).toThrow("1 to 8");
    expect(() => bookingLabel("jimmy/s-0123abcd/lc-box123", ME)).toThrow("at most 8");
    expect(() => bookingLabel("lc-box1", { ...ME, session8: undefined })).toThrow(
      "jimmy/s-<session8>/<name>",
    );
    expect(() => labelsFor("lc/box1", ME)).toThrow("Not a session's label");
  });

  test("a name finds its lease under the new label first, then the older one", () => {
    const legacy = book([], "s-0123abcd/lc-box1", 1, NOW).leases;
    expect(targetOf(legacy, "lc-box1", ME)).toEqual({ label: "s-0123abcd/lc-box1" });
    const both = book(legacy, "jimmy/s-0123abcd/lc-box1", 1, NOW).leases;
    expect(targetOf(both, "lc-box1", ME)).toEqual({ label: "jimmy/s-0123abcd/lc-box1" });
    expect(targetOf([], "lc-box1", ME)).toEqual({ label: "jimmy/s-0123abcd/lc-box1" });
    expect(targetOf([], "52099850", ME)).toEqual({ box: 52099850 });
  });
});
