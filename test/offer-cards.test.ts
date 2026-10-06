import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import {
  compact,
  cpuLink,
  cpuPerf,
  cpuScores,
  indexChips,
  modelKey,
  parseChips,
  resetCpuScores,
  shortCpuName,
} from "../cpu-score";
import { gpuLink } from "../gpu-link";
import { endsCell, placeOf } from "../offers";
import { ctxFor, NOW, offer, setup, vast } from "./fake-vast";

const FIXTURE = await readFile(new URL("./passmark-cpus.txt", import.meta.url), "utf8");
const INDEX = indexChips(parseChips(FIXTURE));

beforeEach(resetCpuScores);
afterEach(resetCpuScores);

describe("cpu-score", () => {
  test("parses name, CPU Mark and the absolute link of each chip", () => {
    const chips = parseChips(FIXTURE);
    expect(chips).toHaveLength(5);
    expect(chips.find((c) => c.name === "Intel Xeon Gold 6430")).toEqual({
      name: "Intel Xeon Gold 6430",
      mark: 53_587,
      url: expect.stringMatching(/^https:\/\/www\.cpubenchmark\.net\/cpu\.php\?cpu=.+&id=\d+$/),
    });
    expect(chips.find((c) => c.name === "AMD EPYC 7742")?.mark).toBe(69_583);
  });

  test("Vast's names match PassMark's by model tokens", () => {
    expect(modelKey("Xeon® Gold 6430")).toBe(modelKey("Intel Xeon Gold 6430"));
    expect(modelKey("AMD EPYC 7742 64-Core Processor")).toBe(modelKey("AMD EPYC 7742"));
    expect(modelKey("Intel Xeon Platinum 8470 @2.00GHz")).toBe("xeon platinum 8470");
    expect(cpuLink({ cpu_name: "Xeon® Gold 6430" }, INDEX)).toContain("cpu.php?cpu=");
    expect(cpuLink({ cpu_name: "AMD EPYC 7742 64-Core Processor" }, INDEX)).toContain("id=");
  });

  test("scales the chip's mark by the threads rented over the chip's threads", () => {
    // 53587 / 64 threads * 128 rented.
    expect(cpuPerf({ cpu_name: "Xeon® Gold 6430", cpu_cores_effective: 128 }, INDEX)).toBeCloseTo(
      107_174,
      0,
    );
    // 69583 / 128 threads * 256 rented.
    expect(
      cpuPerf({ cpu_name: "AMD EPYC 7742 64-Core Processor", cpu_cores_effective: 256 }, INDEX),
    ).toBeCloseTo(139_166, 0);
  });

  test("a chip off PassMark's page, off the thread table, or an offer with no CPU is unscored, never core count", () => {
    expect(
      cpuPerf({ cpu_name: "XEON® PLATINUM 8563C", cpu_cores_effective: 208 }, INDEX),
    ).toBeNull();
    // On the page, but with no known thread count: an unscored chip.
    const odd = indexChips(
      parseChips(
        '<a href="/cpu.php?cpu=AMD+EPYC+9K84&amp;id=1"><span class="prdname">AMD EPYC 9K84</span><span class="count">123,456</span>',
      ),
    );
    expect(cpuPerf({ cpu_name: "AMD EPYC 9K84", cpu_cores_effective: 16 }, odd)).toBeNull();
    expect(cpuPerf({ cpu_cores_effective: 16 }, INDEX)).toBeNull();
    expect(cpuLink({ cpu_name: "XEON® PLATINUM 8563C" }, INDEX)).toBeNull();
  });

  test("short names and compact scores", () => {
    expect(shortCpuName("XEON® PLATINUM 8563C")).toBe("Xeon Plat. 8563C");
    expect(shortCpuName("AMD EPYC 7742 64-Core Processor")).toBe("EPYC 7742");
    expect(shortCpuName("AMD Ryzen Threadripper PRO 5975WX")).toBe("TR PRO 5975WX");
    expect(shortCpuName("Threadripper PRO 5975WX")).toBe("TR PRO 5975WX");
    expect(shortCpuName("Intel(R) Xeon(R) Gold 6430 CPU @ 2.10GHz")).toBe("Xeon Gold 6430");
    expect([compact(139_166), compact(12_886), compact(950), compact(10_812)]).toEqual([
      "139k",
      "12.9k",
      "950",
      "10.8k",
    ]);
  });

  test("the page is fetched once a day with a browser User-Agent, and a failure leaves every chip unscored", async () => {
    const fake = vast([]);
    fake.cpuPage.html = FIXTURE;
    expect((await cpuScores(fake.get, NOW)).size).toBe(5);
    await cpuScores(fake.get, NOW + 23 * 3_600_000);
    expect(fake.cpuPage.fetches).toHaveLength(1);
    expect(fake.cpuPage.fetches[0]).toContain("Chrome/128");
    await cpuScores(fake.get, NOW + 25 * 3_600_000);
    expect(fake.cpuPage.fetches).toHaveLength(2);

    resetCpuScores();
    const blocked = vast([]);
    expect((await cpuScores(blocked.get, NOW)).size).toBe(0);
  });
});

describe("gpu-link", () => {
  test("links the known names and leaves the rest", () => {
    expect(gpuLink("RTX PRO 6000 S")).toBe(
      "https://www.videocardbenchmark.net/gpu.php?gpu=RTX+PRO+6000+Blackwell+Server+Edition&id=6962",
    );
    expect(gpuLink("RTX PRO 6000 WS")).toContain("Workstation+Edition&id=6307");
    expect(gpuLink("RTX 4090")).toContain("id=4606");
    expect(gpuLink("H100 SXM")).toBeNull();
    expect(gpuLink(undefined)).toBeNull();
  });
});

const BIG = {
  gpu_name: "RTX PRO 6000 S",
  num_gpus: 8,
  gpu_ram: 97_887,
  dlperf: 1330.749,
  gpu_mem_bw: 1397.8,
  cpu_name: "XEON® PLATINUM 8563C",
  cpu_cores_effective: 208,
  cpu_ram: 1_031_712,
  disk_space: 2872,
  inet_down: 1881.3,
  verification: "deverified",
  geolocation: "California, US",
  end_date: NOW / 1000 + 30 * 86_400,
};
const WS = {
  ...BIG,
  gpu_name: "RTX PRO 6000 WS",
  dlperf: 680,
  cpu_name: "AMD EPYC 7742 64-Core Processor",
  cpu_cores_effective: 256,
  verification: "verified",
};
const RENT = {
  name: "job1",
  budget: 20,
  offers: [1, 2, 3],
  image: "ubuntu:22.04",
  disk_gb: 40,
  purpose: "rank by performance",
};

function world(features: string[] = []) {
  const fake = vast([
    offer(1, 9.822, BIG),
    offer(2, 10.8, WS),
    offer(3, 4, {
      gpu_name: "RTX 4090",
      num_gpus: 2,
      gpu_frac: 0.5,
      dlperf: 80,
      cpu_name: "Xeon® Gold 6430",
      cpu_cores_effective: 128,
    }),
  ]);
  fake.cpuPage.html = FIXTURE;
  return { fake, ready: setup(fake, features) };
}

const COLUMNS = [
  "GPU",
  "VRAM",
  "GPU perf · /$",
  "Mem GB/s",
  "CPU",
  "CPU perf · /$",
  "RAM",
  "Disk",
  "Mbps",
  "$/h",
  "Hours",
  "Ends in",
  "Rel.",
  "Verified",
  "Where",
  "Offer",
];
const at = (name: string) => COLUMNS.indexOf(name);

const NORWAY = {
  gpu_name: "RTX 4090",
  num_gpus: 1,
  gpu_frac: 0.25,
  gpu_ram: 24564,
  dlperf: 96.5,
  gpu_mem_bw: 879,
  cpu_name: "AMD Ryzen Threadripper PRO 5995WX",
  cpu_cores_effective: 16,
  cpu_ram: 32_000,
  disk_space: 746,
  inet_down: 904,
  reliability: 0.998,
  verification: "verified",
  geolocation: "Norway, NO",
  end_date: NOW / 1000 + 14.5 * 86_400,
};
const SOUTH_AFRICA = {
  gpu_name: "RTX 4090",
  num_gpus: 2,
  gpu_frac: 1,
  gpu_ram: 24564,
  dlperf: 150,
  gpu_mem_bw: 878,
  cpu_name: "Intel(R) Xeon(R) CPU E7-4860 v2 @ 2.60GHz",
  cpu_cores_effective: 96,
  cpu_ram: 129_000,
  disk_space: 7355,
  inet_down: 173,
  reliability: 0.989,
  verification: "verified",
  geolocation: "South Africa, ZA",
  end_date: NOW / 1000 + 87.2 * 86_400,
};
const TWO = { ...RENT, offers: [53845009, 51765869], budget: 20 };
const twoOffers = () => {
  const fake = vast([offer(53845009, 0.45, NORWAY), offer(51765869, 0.72, SOUTH_AFRICA)]);
  fake.cpuPage.html = FIXTURE;
  return fake;
};

describe("the rent card", () => {
  test("is compact: one cell each for GPU perf and /$, CPU perf and /$, and plain text without pick-links or pick-cells", async () => {
    const { ready } = world();
    const { tool } = await ready;
    const { ctx, cards } = ctxFor([null]);
    await tool("vast_rent").call(RENT, ctx);
    const card = cards[0];
    expect(card?.columns).toEqual(COLUMNS);
    expect(card?.rows[0]).toEqual([
      "8x RTX PRO 6000 S",
      "8 × 98 GB",
      "1331 · 135",
      "1398",
      "208 × Xeon Plat. 8563C",
      "–",
      "1032 GB",
      "2872 GB",
      "1881",
      "9.82",
      (20 / 9.822).toFixed(1),
      "30 d",
      "0.990",
      "lost",
      "California, US",
      "1",
    ]);
    expect(card?.rows[1]?.slice(0, 6)).toEqual([
      "8x RTX PRO 6000 WS",
      "8 × 98 GB",
      "680 · 63",
      "1398",
      "256 × EPYC 7742",
      "139k · 12.9k",
    ]);
    expect(card?.rows[1]?.[at("Verified")]).toBe("yes");
    // A part of a machine says so in the GPU cell; 53587 / 64 * 128 = 107k, per $4/h 26.8k.
    expect(card?.rows[2]?.[0]).toBe("2x RTX 4090 · 2 of 4");
    expect(card?.rows[2]?.[at("CPU")]).toBe("128 × Xeon Gold 6430");
    expect(card?.rows[2]?.[at("CPU perf · /$")]).toBe("107k · 26.8k");
    expect(card?.amount?.perRow).toEqual({ column: "Hours", rateColumn: "$/h", unit: "h" });
    expect(card).not.toHaveProperty("links");
    expect(card).not.toHaveProperty("titles");
    expect(card).not.toHaveProperty("cellKinds");
  });

  test("the $/h cell is a number prifly can divide the budget by, and Hours is the budget over the rate", async () => {
    const fake = vast([offer(1, 0.45), offer(2, 0.072), offer(3, 12.5)]);
    const { tool } = await setup(fake);
    const { ctx, cards } = ctxFor([null]);
    await tool("vast_rent").call({ ...RENT, offers: [1, 2, 3] }, ctx);
    const card = cards[0];
    const perRow = card?.amount?.perRow;
    expect(card?.columns[at("Hours")]).toBe(perRow?.column);
    expect(card?.columns[at("$/h")]).toBe(perRow?.rateColumn);
    // Two decimals, three under $0.10 so a cheap rate is not rounded away.
    expect(card?.rows.map((row) => row[at("$/h")])).toEqual(["0.45", "0.072", "12.50"]);
    for (const row of card?.rows ?? []) {
      const rate = Number(row[at("$/h")]);
      expect(Number.isFinite(rate) && rate > 0).toBe(true);
      // What prifly computes for the budget on the card is what the Hours cell says.
      expect(Math.abs(20 / rate - Number(row[at("Hours")]))).toBeLessThan(0.2);
    }
  });
});

describe("the rent card, Where and Offer", () => {
  test("without pick-cells: Where is the full geolocation text and Offer the id, plain", async () => {
    const { tool } = await setup(twoOffers());
    const { ctx, cards } = ctxFor([null]);
    await tool("vast_rent").call(TWO, ctx);
    const card = cards[0];
    expect(card?.rows[0]).toEqual([
      "RTX 4090 · 1 of 4",
      "25 GB",
      "97 · 214",
      "879",
      "16 × TR PRO 5995WX",
      "11.8k · 26.3k",
      "32 GB",
      "746 GB",
      "904",
      "0.45",
      (20 / 0.45).toFixed(1),
      "14 d",
      "0.998",
      "yes",
      "Norway, NO",
      "53845009",
    ]);
    expect(card?.rows[1]).toEqual([
      "2x RTX 4090",
      "2 × 25 GB",
      "150 · 208",
      "878",
      "96 × Xeon E7-4860 v2",
      "–",
      "129 GB",
      "7355 GB",
      "173",
      "0.72",
      (20 / 0.72).toFixed(1),
      "87 d",
      "0.989",
      "yes",
      "South Africa, ZA",
      "51765869",
    ]);
    expect(card).not.toHaveProperty("titles");
    expect(card).not.toHaveProperty("cellKinds");
  });

  test("with pick-cells (no pick-links): Where is the code as a flag with the place as title, Offer stays the id with its title and no icon", async () => {
    const { tool } = await setup(twoOffers(), ["pick-cells"]);
    const { ctx, cards } = ctxFor([null]);
    await tool("vast_rent").call(TWO, ctx);
    const card = cards[0];
    expect(card?.rows.map((row) => [row[at("Where")], row[at("Offer")]])).toEqual([
      ["NO", "53845009"],
      ["ZA", "51765869"],
    ]);
    expect(card?.titles?.map((row) => row[at("Where")])).toEqual(["Norway", "South Africa"]);
    expect(card?.titles?.map((row) => row[at("Offer")])).toEqual([
      "Offer 53845009 on Vast.ai",
      "Offer 51765869 on Vast.ai",
    ]);
    expect(card?.cellKinds?.map((row) => row[at("Where")])).toEqual(["flag", "flag"]);
    // An icon without a link would be a dead icon.
    expect(card?.cellKinds?.map((row) => row[at("Offer")])).toEqual([null, null]);
    expect(card).not.toHaveProperty("links");
    for (const row of [...(card?.titles ?? []), ...(card?.cellKinds ?? [])]) {
      expect(row).toHaveLength(COLUMNS.length);
    }
  });

  test("with pick-cells and pick-links: Offer is a link icon to Vast's console, GPU and CPU still link to PassMark", async () => {
    const { tool } = await setup(twoOffers(), ["pick-cells", "pick-links"]);
    const { ctx, cards } = ctxFor([null]);
    await tool("vast_rent").call(TWO, ctx);
    const card = cards[0];
    expect(card?.cellKinds?.map((row) => row[at("Offer")])).toEqual(["link-icon", "link-icon"]);
    expect(card?.links?.map((row) => row[at("Offer")])).toEqual([
      "https://cloud.vast.ai/?ask=53845009",
      "https://cloud.vast.ai/?ask=51765869",
    ]);
    expect(card?.links?.[0]?.[at("GPU")]).toContain("id=4606");
    expect(card?.links?.[0]?.[at("CPU")]).toContain("Threadripper+PRO+5995WX");
    expect(card?.links?.[1]?.[at("CPU")]).toBeNull();
    // The cell text stays the id, for older displays and as the aria-label.
    expect(card?.rows[0]?.[at("Offer")]).toBe("53845009");
  });

  test("with pick-links only the offer id links to Vast's console as text", async () => {
    const { tool } = await setup(twoOffers(), ["pick-links"]);
    const { ctx, cards } = ctxFor([null]);
    await tool("vast_rent").call(TWO, ctx);
    const card = cards[0];
    expect(card?.links?.[0]?.[at("Offer")]).toBe("https://cloud.vast.ai/?ask=53845009");
    expect(card?.rows[0]?.[at("Where")]).toBe("Norway, NO");
    expect(card).not.toHaveProperty("cellKinds");
  });
});

describe("the rent card, links and gaps", () => {
  test("with pick-links the GPU and CPU cells link to PassMark, null where unscored or unmapped", async () => {
    const { ready } = world(["pick-links"]);
    const { tool } = await ready;
    const { ctx, cards } = ctxFor([null]);
    await tool("vast_rent").call(RENT, ctx);
    const links = cards[0]?.links;
    expect(links).toHaveLength(3);
    for (const row of links ?? []) expect(row).toHaveLength(COLUMNS.length);
    expect(links?.[0]?.[at("GPU")]).toContain("Server+Edition&id=6962");
    expect(links?.[0]?.[at("CPU")]).toBeNull();
    expect(links?.[1]?.[at("CPU")]).toMatch(
      /^https:\/\/www\.cpubenchmark\.net\/cpu\.php\?cpu=AMD\+EPYC\+7742&id=\d+$/,
    );
    expect(links?.[2]?.[at("GPU")]).toContain("id=4606");
    expect(links?.[2]?.[at("CPU")]).toContain("Gold+6430");
    const gpuCpuOffer = [at("GPU"), at("CPU"), at("Offer")];
    const others = links?.flatMap((row) => row.filter((_, i) => !gpuCpuOffer.includes(i)));
    expect(others?.every((link) => link === null)).toBe(true);
  });

  test("a location with no code shows its text, no flag and no title, with pick-cells too", async () => {
    const fake = vast([
      offer(1, 1, { geolocation: "Somewhere Nice" }),
      offer(2, 1, { geolocation: null }),
    ]);
    const { tool } = await setup(fake, ["pick-cells"]);
    const { ctx, cards } = ctxFor([null]);
    await tool("vast_rent").call({ ...RENT, offers: [1, 2] }, ctx);
    const card = cards[0];
    expect(card?.rows.map((row) => row[at("Where")])).toEqual(["Somewhere Nice", "?"]);
    expect(card?.titles?.map((row) => row[at("Where")])).toEqual([null, null]);
    expect(card?.cellKinds?.map((row) => row[at("Where")])).toEqual([null, null]);
  });

  test("a PassMark page that cannot be read leaves the CPUs unscored and the rent working", async () => {
    const { fake, ready } = world();
    fake.cpuPage.html = null;
    const { tool } = await ready;
    const { ctx, cards } = ctxFor([null]);
    await tool("vast_rent").call(RENT, ctx);
    expect(cards[0]?.rows.map((row) => row[at("CPU perf · /$")])).toEqual(["–", "–", "–"]);
  });

  test("an offer Vast gives no scores for shows dashes and a question mark, and verification maps", async () => {
    const fake = vast([offer(1, 1)]);
    const { tool } = await setup(fake);
    const { ctx, cards } = ctxFor([null]);
    await tool("vast_rent").call({ ...RENT, offers: [1] }, ctx);
    const row = cards[0]?.rows[0];
    expect([row?.[at("GPU perf · /$")], row?.[at("Mem GB/s")]]).toEqual(["–", "?"]);
    expect(row?.[at("Verified")]).toBe("?");
  });
});

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

describe("vast_offers text", () => {
  test("ranks by GPU and CPU performance, memory bandwidth and verification", async () => {
    const { ready } = world();
    const { tool } = await ready;
    const text = await tool("vast_offers").call({}, ctxFor([]).ctx);
    expect(text).toContain(
      "GPU perf 680 (63 per $/h) · 1398 GB/s memory · 256 × EPYC 7742 · CPU perf 139k (12.9k per $/h)",
    );
    expect(text).toContain("CPU perf unscored (– per $/h)");
    expect(text).toContain("verified lost");
    expect(text).toContain("verified yes");
  });
});
