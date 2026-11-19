import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createInstance,
  destroyInstance,
  getAccount,
  KeyRefused,
  listInstances,
  OfferGone,
  parsePage,
  readApiKeys,
  requestLogs,
  VAULT_ENTRY,
  withKeys,
} from "../vast-api";

/** A recorded `GET /api/v1/instances/` page, ids, labels and hosts replaced. */
const recorded: unknown = await Bun.file(join(import.meta.dir, "instances-page.json")).json();

describe("parsePage", () => {
  test("reads a recorded page into the fields the extension shows", () => {
    const { rows, next } = parsePage(recorded);
    expect(next).toBeNull();
    expect(rows.map((row) => row.id)).toEqual([10000001, 10000002, 10000003]);
    expect(rows[0]).toEqual({
      id: 10000001,
      label: "s-0123abcd/lc-box1",
      gpu_name: "RTX 5090",
      num_gpus: 1,
      disk_space: 40,
      actual_status: "exited",
      intended_status: "stopped",
      end_date: 1790000000,
      dph_total: 0.48518518518518516,
      cpu_util: 12.34625,
      gpu_util: 0,
      cpu_cores: 8,
      mem_usage: 1.6829644799999999,
      mem_limit: 30.670848,
      ssh_host: "ssh1.vast.ai",
      ssh_port: 20001,
    });
    expect(rows[2]?.label).toBeNull();
    expect(rows.map((row) => row.end_date)).toEqual([1790000000, null, 1790003600.5]);
  });

  test("reads the GPU temperature, video memory and core counts", () => {
    const { rows } = parsePage({
      instances: [
        { id: 1, gpu_temp: 72, vmem_usage: 76.9, cpu_cores: 384, cpu_cores_effective: 384.0 },
      ],
    });
    expect(rows).toEqual([
      { id: 1, gpu_temp: 72, vmem_usage: 76.9, cpu_cores: 384, cpu_cores_effective: 384 },
    ]);
  });

  test("an odd field is dropped, not the box", () => {
    const { rows } = parsePage({
      instances: [{ id: 7, gpu_util: "n/a", label: "  s-0123abcd/x  ", new_field: { a: 1 } }],
    });
    expect(rows).toEqual([{ id: 7, label: "s-0123abcd/x" }]);
  });

  test("a null ssh host or port is a missing one", () => {
    const { rows } = parsePage({ instances: [{ id: 1, ssh_host: null, ssh_port: null }] });
    expect(rows).toEqual([{ id: 1 }]);
  });

  test("a row that is not a box is skipped", () => {
    expect(parsePage({ instances: [null, 3, { id: 1 }] }).rows).toEqual([{ id: 1 }]);
  });

  test("no instances at all is an empty list", () => {
    expect(parsePage({ instances: null, next_token: "" })).toEqual({ rows: [], next: null });
  });

  test("a body that is not a page is an error", () => {
    expect(() => parsePage("<html>")).toThrow("cannot read");
  });
});

type Call = { url: string; auth: string };

function server(pages: Record<string, { status: number; body: unknown }>) {
  const calls: Call[] = [];
  const get = async (url: string, init: RequestInit) => {
    const auth = new Headers(init.headers).get("Authorization") ?? "";
    calls.push({ url, auth });
    const key = `${auth} ${new URL(url).searchParams.get("after_token") ?? ""}`.trim();
    const page = pages[key] ?? { status: 404, body: { msg: "no such page" } };
    return new Response(JSON.stringify(page.body), { status: page.status });
  };
  return { calls, get };
}

describe("listInstances", () => {
  test("asks what the CLI asks, and follows next_token", async () => {
    const { calls, get } = server({
      "Bearer k1": { status: 200, body: { instances: [{ id: 1 }], next_token: "t2" } },
      "Bearer k1 t2": { status: 200, body: { instances: [{ id: 2 }], next_token: null } },
    });
    const rows = await listInstances(["k1"], get);
    expect(rows.map((row) => row.id)).toEqual([1, 2]);
    const first = new URL(calls[0]?.url ?? "");
    expect(first.origin + first.pathname).toBe("https://console.vast.ai/api/v1/instances/");
    expect(first.searchParams.get("select_filters")).toBe("{}");
    expect(first.searchParams.get("order_by")).toBe('[{"col":"id","dir":"asc"}]');
    expect(first.searchParams.get("limit")).toBe("25");
    expect(new URL(calls[1]?.url ?? "").searchParams.get("after_token")).toBe("t2");
  });

  test("an expired 2FA key falls back to the API key, as the CLI does", async () => {
    const { get } = server({
      "Bearer tfa": { status: 401, body: { msg: "session expired" } },
      "Bearer api": { status: 200, body: { instances: [{ id: 3 }] } },
    });
    expect((await listInstances(["tfa", "api"], get)).map((row) => row.id)).toEqual([3]);
  });

  test("a refusal says why and never carries the key", async () => {
    const { get } = server({ "Bearer secret-key": { status: 401, body: { msg: "bad key" } } });
    const failed = listInstances(["secret-key"], get);
    await expect(failed).rejects.toThrow("Vast.ai instance list failed (401): bad key");
    await expect(failed).rejects.not.toThrow("secret-key");
  });

  test("a server error is not retried with another key", async () => {
    const { calls, get } = server({ "Bearer a": { status: 500, body: {} } });
    await expect(listInstances(["a", "b"], get)).rejects.toThrow("(500)");
    expect(calls).toHaveLength(1);
  });

  test("no key at all says how to set one", async () => {
    await expect(listInstances([], server({}).get)).rejects.toThrow("vastai set api-key");
  });
});

describe("readApiKeys", () => {
  test("the environment wins, as it does for the CLI", async () => {
    expect(await readApiKeys({ VAST_API_KEY: " env " }, "/nonexistent")).toEqual(["env"]);
  });

  test("2FA key, then API key, then the legacy file", async () => {
    const home = await mkdtemp(join(tmpdir(), "vastai-keys-"));
    await mkdir(join(home, ".config", "vastai"), { recursive: true });
    await writeFile(join(home, ".config", "vastai", "vast_tfa_key"), "tfa\n");
    await writeFile(join(home, ".config", "vastai", "vast_api_key"), "api\n");
    await writeFile(join(home, ".vast_api_key"), "api\n");
    expect(await readApiKeys({}, home)).toEqual(["tfa", "api"]);
  });

  test("$XDG_CONFIG_HOME moves the config folder", async () => {
    const home = await mkdtemp(join(tmpdir(), "vastai-keys-"));
    await mkdir(join(home, "xdg", "vastai"), { recursive: true });
    await writeFile(join(home, "xdg", "vastai", "vast_api_key"), "xdg");
    expect(await readApiKeys({ XDG_CONFIG_HOME: join(home, "xdg") }, home)).toEqual(["xdg"]);
  });

  test("none anywhere is an empty list", async () => {
    expect(await readApiKeys({}, await mkdtemp(join(tmpdir(), "vastai-keys-")))).toEqual([]);
  });

  /** A fake `api.secrets` and `api.vault`, each call written down. */
  function fakes(stored: string | null, vaulted: string | null) {
    const calls: string[] = [];
    const sets: [string, string | null][] = [];
    const logged: string[] = [];
    const values = new Map<string, string | null>([["apiKey", stored]]);
    return {
      calls,
      sets,
      logged,
      sources: {
        secrets: {
          get: async (key: string) => {
            calls.push(`secrets.get ${key}`);
            return values.get(key) ?? null;
          },
          set: async (key: string, next: string | null) => {
            sets.push([key, next]);
            values.set(key, next);
          },
        },
        vault: {
          read: async (name: string) => {
            calls.push(`vault.read ${name}`);
            return vaulted;
          },
        },
        log: (event: string, fields?: Record<string, unknown>) =>
          logged.push(`${event} ${String(fields?.["message"] ?? "")}`),
      },
    };
  }

  async function homeWith(file: string | null) {
    const home = await mkdtemp(join(tmpdir(), "vastai-keys-"));
    await mkdir(join(home, ".config", "vastai"), { recursive: true });
    if (file !== null) await writeFile(join(home, ".config", "vastai", "vast_api_key"), file);
    return home;
  }

  test("the extension's own secret goes first, the CLI's keys after it, each once; the vault is not read", async () => {
    const home = await homeWith("file\n");
    const { sources, calls } = fakes(" own\n", "vaulted");
    expect(await readApiKeys({}, home, sources)).toEqual(["own", "file"]);
    expect(calls).toEqual(["secrets.get apiKey"]);
    expect(await readApiKeys({}, home, fakes("file", null).sources)).toEqual(["file"]);
    expect(await readApiKeys({ VAST_API_KEY: "env" }, home, fakes("v", null).sources)).toEqual([
      "v",
      "env",
    ]);
  });

  test("no secret yet: the vault entry `vastai` is copied into the secrets once, and used", async () => {
    const home = await homeWith("file\n");
    const { sources, sets, logged, calls } = fakes(null, " vaulted\n");
    expect(VAULT_ENTRY).toBe("vastai");
    expect(await readApiKeys({}, home, sources)).toEqual(["vaulted", "file"]);
    expect(sets).toEqual([
      ["apiKey", "vaulted"],
      ["apiKeyMigrated", "1"],
    ]);
    expect(logged).toEqual([
      "api_key_migrated copied vastai from the vault into this extension's secrets",
    ]);
    // The next refresh finds the secret and leaves the vault alone.
    expect(await readApiKeys({}, home, sources)).toEqual(["vaulted", "file"]);
    expect(sets).toHaveLength(2);
    expect(calls.filter((call) => call.startsWith("vault.read"))).toEqual(["vault.read vastai"]);
  });

  test("after a migration, removing the key is not undone by the vault entry", async () => {
    const home = await homeWith("file\n");
    const { sources, sets, calls } = fakes(null, "vaulted");
    expect(await readApiKeys({}, home, sources)).toEqual(["vaulted", "file"]);
    await sources.secrets.set("apiKey", null);
    sets.length = 0;
    calls.length = 0;
    expect(await readApiKeys({}, home, sources)).toEqual(["file"]);
    expect(sets).toEqual([]);
    expect(calls.some((call) => call.startsWith("vault.read"))).toBe(false);
  });

  test("a copy that fails is logged, and the vault key is still used", async () => {
    const home = await homeWith(null);
    const { sources, logged } = fakes(null, "vaulted");
    const failing = {
      ...sources,
      secrets: {
        get: sources.secrets.get,
        set: async () => {
          throw new Error("secrets are stopped");
        },
      },
    };
    expect(await readApiKeys({}, home, failing)).toEqual(["vaulted"]);
    expect(logged).toEqual(["api_key_migrate_failed secrets are stopped"]);
  });

  test("a prifly without `api.secrets` still uses the vault key, with no copy", async () => {
    const home = await homeWith("file");
    const { sources, sets } = fakes(null, "vaulted");
    const old = { vault: sources.vault, log: sources.log };
    expect(await readApiKeys({}, home, old)).toEqual(["vaulted", "file"]);
    expect(sets).toEqual([]);
  });

  test("neither a secret nor a vault entry, or a prifly with neither, reads the files as before", async () => {
    const home = await mkdtemp(join(tmpdir(), "vastai-keys-"));
    await writeFile(join(home, ".vast_api_key"), "legacy");
    expect(await readApiKeys({}, home, fakes(null, null).sources)).toEqual(["legacy"]);
    expect(await readApiKeys({}, home, {})).toEqual(["legacy"]);
    expect(await readApiKeys({}, home)).toEqual(["legacy"]);
  });

  test("nothing anywhere: the message names Settings → Extensions, not the vault", async () => {
    const home = await mkdtemp(join(tmpdir(), "vastai-keys-"));
    const keys = await readApiKeys({}, home, fakes(null, null).sources);
    expect(keys).toEqual([]);
    const failure = await withKeys(keys, async () => "never").catch((caught: unknown) => caught);
    const message = failure instanceof Error ? failure.message : "";
    expect(message).toContain("Settings → Extensions");
    expect(message).toContain("vastai set api-key");
    expect(message.toLowerCase()).not.toContain("vault");
  });
});

/** A fake Vast.ai that records each request and answers from a queue. */
function recording(...answers: Response[]) {
  const seen: { url: string; init: RequestInit }[] = [];
  const get = async (url: string, init: RequestInit) => {
    seen.push({ url, init });
    return answers.shift() ?? new Response("{}", { status: 500 });
  };
  return { seen, get };
}

describe("destroyInstance", () => {
  test("is a DELETE of the instance with the bearer key, as guard.sh sends it", async () => {
    const { seen, get } = recording(new Response("{}"));
    await destroyInstance("secret", 52099850, get);
    expect(seen).toHaveLength(1);
    expect(seen[0]?.url).toBe("https://console.vast.ai/api/v0/instances/52099850/");
    expect(seen[0]?.init.method).toBe("DELETE");
    expect(new Headers(seen[0]?.init.headers).get("Authorization")).toBe("Bearer secret");
  });

  test("a 429 is asked again after a wait, and the second answer counts", async () => {
    const { seen, get } = recording(
      new Response(JSON.stringify({ msg: "API requests too frequent" }), { status: 429 }),
      Response.json({ success: true }),
    );
    const waits: number[] = [];
    await destroyInstance("k", 5, get, async (ms) => void waits.push(ms));
    expect(seen).toHaveLength(2);
    expect(waits).toEqual([2000]);
  });

  test("Retry-After sets the wait, a 5xx is retried, and a 404 is not", async () => {
    const waits: number[] = [];
    const sleep = async (ms: number) => void waits.push(ms);
    const slow = new Response("{}", { status: 429, headers: { "Retry-After": "7" } });
    const retried = recording(slow, new Response("bad", { status: 502 }), new Response("{}"));
    await destroyInstance("k", 5, retried.get, sleep);
    expect(waits).toEqual([7000, 4000]);
    const gone = recording(new Response("{}", { status: 404 }), new Response("{}"));
    await expect(destroyInstance("k", 5, gone.get, sleep)).rejects.toThrow("(404)");
    expect(gone.seen).toHaveLength(1);
  });

  test("a 429 every time fails after four tries, with Vast.ai's reason", async () => {
    const answers = Array.from(
      { length: 6 },
      () => new Response(JSON.stringify({ msg: "API requests too frequent" }), { status: 429 }),
    );
    const { seen, get } = recording(...answers);
    const failure = await destroyInstance("k", 5, get, async () => undefined).catch(
      (e: Error) => e,
    );
    expect((failure as Error).message).toBe(
      "Vast.ai destroy of #5 failed (429): API requests too frequent",
    );
    expect(seen).toHaveLength(4);
  });

  test("a 200 whose body says success false is a failure", async () => {
    const { get } = recording(Response.json({ success: false, msg: "instance is locked" }));
    await expect(destroyInstance("k", 5, get)).rejects.toThrow(
      "Vast.ai destroy of #5 failed: instance is locked",
    );
  });

  test("a refusal says why, without the key", async () => {
    const { get } = recording(
      new Response(JSON.stringify({ msg: "no such instance" }), { status: 404 }),
    );
    const failure = await destroyInstance("secret", 1, get).catch((e: Error) => e);
    expect((failure as Error).message).toBe("Vast.ai destroy of #1 failed (404): no such instance");
  });

  test("a refused key moves on to the next with withKeys", async () => {
    const { seen, get } = recording(new Response("{}", { status: 401 }), new Response("{}"));
    await withKeys(["old", "new"], (key) => destroyInstance(key, 5, get));
    expect(seen.map((r) => new Headers(r.init.headers).get("Authorization"))).toEqual([
      "Bearer old",
      "Bearer new",
    ]);
    await expect(
      destroyInstance("k", 5, recording(new Response("{}", { status: 403 })).get),
    ).rejects.toBeInstanceOf(KeyRefused);
  });
});

describe("createInstance", () => {
  const request = {
    image: "ubuntu:22.04",
    disk: 40,
    label: "jimmy/s-0123abcd/lc-box1",
    onstart: "sleep infinity",
    env: { "-p 8080:8080/tcp": "1" },
  };

  test("PUTs the CLI's body to the offer, with cancel_unavail, and returns the new id", async () => {
    const { seen, get } = recording(
      new Response(JSON.stringify({ success: true, new_contract: 77 })),
    );
    expect(await createInstance("secret", 4242, request, get)).toBe(77);
    expect(seen[0]?.url).toBe("https://console.vast.ai/api/v0/asks/4242/");
    expect(seen[0]?.init.method).toBe("PUT");
    const body = JSON.parse(String(seen[0]?.init.body));
    expect(body).toMatchObject({
      image: "ubuntu:22.04",
      disk: 40,
      label: request.label,
      onstart: "sleep infinity",
      cancel_unavail: true,
      runtype: "ssh_direc ssh_proxy",
      env: { "-p 8080:8080/tcp": "1" },
    });
  });

  test("an offer that is gone is OfferGone; a server error is not", async () => {
    const gone = recording(
      new Response(JSON.stringify({ success: false, msg: "offer unavailable" })),
    );
    await expect(createInstance("k", 1, request, gone.get)).rejects.toBeInstanceOf(OfferGone);
    const taken = recording(
      new Response(JSON.stringify({ msg: "no longer available" }), { status: 400 }),
    );
    await expect(createInstance("k", 1, request, taken.get)).rejects.toBeInstanceOf(OfferGone);
    const broken = recording(new Response("oops", { status: 502 }));
    const failure = await createInstance("k", 1, request, broken.get).catch((e: Error) => e);
    expect(failure).not.toBeInstanceOf(OfferGone);
  });
});

describe("requestLogs", () => {
  test("asks, then fetches the returned address without the key", async () => {
    const { seen, get } = recording(
      new Response(JSON.stringify({ result_url: "https://logs.example/x" })),
      new Response("not yet", { status: 404 }),
      new Response("line1\nline2"),
    );
    expect(await requestLogs("secret", 9, 50, get, async () => undefined)).toBe("line1\nline2");
    expect(seen[0]?.url).toBe("https://console.vast.ai/api/v0/instances/request_logs/9/");
    expect(seen[0]?.init.method).toBe("PUT");
    expect(JSON.parse(String(seen[0]?.init.body))).toEqual({ tail: "50" });
    expect(seen[1]?.url).toBe("https://logs.example/x");
    expect(new Headers(seen[1]?.init.headers).get("Authorization")).toBeNull();
  });
});

describe("getAccount", () => {
  const answer =
    (body: unknown, status = 200) =>
    async () =>
      new Response(JSON.stringify(body), { status });

  test("the credit, and the threshold only while the auto-stop is on", async () => {
    const on = { credit: 48.6, balance_threshold: -0.01, balance_threshold_enabled: true };
    expect(await getAccount("k", answer(on))).toEqual({ credit: 48.6, threshold: -0.01 });
    const off = { ...on, balance_threshold_enabled: false };
    expect(await getAccount("k", answer(off))).toEqual({ credit: 48.6, threshold: null });
  });

  test("an account with no credit to read, or a refused key, is an error", async () => {
    await expect(getAccount("k", answer({ balance: 0 }))).rejects.toThrow("cannot read");
    await expect(getAccount("k", answer({ msg: "no" }, 401))).rejects.toBeInstanceOf(KeyRefused);
  });
});
