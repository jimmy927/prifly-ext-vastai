import { describe, expect, test } from "bun:test";
import { endsCell, placeOf } from "../offers";
import { NOW } from "./fake-vast";

describe("placeOf", () => {
  test("reads the code Vast ends its geolocation with and spells the place out", () => {
    expect(placeOf("Norway, NO")).toEqual({ code: "NO", text: "Norway, NO", full: "Norway" });
    expect(placeOf("British Columbia, CA")).toEqual({
      code: "CA",
      text: "British Columbia, CA",
      full: "British Columbia, Canada",
    });
    expect(placeOf("California, US").full).toBe("California, United States");
    expect(placeOf("Frankfurt am Main, Hesse, DE").full).toBe("Frankfurt am Main, Hesse, Germany");
    expect(placeOf("SE")).toEqual({ code: "SE", text: "SE", full: "Sweden" });
  });

  test("no code, an unknown code or no location leaves the text and no place", () => {
    expect(placeOf("Somewhere Nice")).toEqual({ code: null, text: "Somewhere Nice", full: null });
    expect(placeOf("Narnia, ZZ")).toEqual({ code: null, text: "Narnia, ZZ", full: null });
    expect(placeOf("Norway, norway").code).toBeNull();
    expect(placeOf(null)).toEqual({ code: null, text: "?", full: null });
    expect(placeOf(undefined).code).toBeNull();
    expect(placeOf("  ").text).toBe("?");
  });
});

describe("endsCell", () => {
  const ends = (hours: number | null) =>
    endsCell(
      {
        ask_contract_id: 1,
        dph_total: 1,
        end_date: hours === null ? undefined : NOW / 1000 + hours * 3600,
      },
      NOW,
    );
  test("whole days, under a day whole hours, none as no end date", () => {
    expect(ends(14 * 24 + 23)).toBe("14 d");
    expect(ends(24)).toBe("1 d");
    expect(ends(23.9)).toBe("23 h");
    expect(ends(7.2)).toBe("7 h");
    expect(ends(0.5)).toBe("<1 h");
    expect(ends(-3)).toBe("<1 h");
    expect(ends(null)).toBe("no end date");
  });
});
