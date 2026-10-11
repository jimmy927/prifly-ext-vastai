/**
 * Which session a serverless endpoint is for.
 *
 * A serverless endpoint's workers are boxes Vast.ai starts and stops itself,
 * labelled `<endpoint name>:<endpoint id>:<worker group id>`: nothing in the
 * label says which session made the endpoint or is sending it work. On
 * 2026-10-06 the panel showed rj-judge and two rj-reranker workers as "No
 * session"; only session e5636c90's transcript said it had created endpoints
 * 39180 and 38596, with Vast's Python SDK.
 *
 * So a session claims an endpoint with `vast_claim_endpoint` once it makes or
 * starts using one, and the claim is kept in the extension's store
 * (`store.ts`: prifly's `api.state`, or `endpoints.json` on an older prifly),
 * changed one claim at a time as the leases are. A later claim of the same
 * endpoint by another session replaces it: the endpoint shows on whoever uses
 * it now.
 */

import { z } from "zod";
import type { Store } from "./store";

const ClaimSchema = z.object({
  endpoint: z.number().int(),
  /** The endpoint's name when it was claimed: "rj-judge". */
  name: z.string(),
  /** The full id of the session that claimed it. */
  session: z.string(),
  /** Epoch ms. */
  at: z.number(),
});
export type Claim = z.infer<typeof ClaimSchema>;

const FileSchema = z.object({ endpoints: z.array(ClaimSchema) });

/** A serverless worker's label: `rj-judge:39180:49751`. */
const WORKER = /^(.+):(\d+):(\d+)$/;

export type Worker = { endpoint: string; endpointId: number; group: number };

/** The endpoint a worker's label names, or null for any other box. */
export function workerOf(label: string): Worker | null {
  const match = WORKER.exec(label);
  if (match === null) return null;
  const [, endpoint = "", id = "", group = ""] = match;
  return { endpoint, endpointId: Number(id), group: Number(group) };
}

export async function readClaims(store: Store): Promise<Claim[]> {
  const kept = await store.get("endpoints");
  return kept === undefined ? [] : FileSchema.parse(kept).endpoints;
}

/** The session each claimed endpoint is for, by endpoint id. */
export function claimMap(claims: readonly Claim[]): Map<number, string> {
  return new Map(claims.map((c) => [c.endpoint, c.session]));
}

/** Claim `endpoint` for `session`, replacing any earlier claim of it. */
export function claimEndpoint(store: Store, claim: Claim): Promise<Claim | null> {
  return store.update("endpoints", (kept) => {
    const claims = kept === undefined ? [] : FileSchema.parse(kept).endpoints;
    const earlier = claims.find((c) => c.endpoint === claim.endpoint) ?? null;
    const endpoints = [...claims.filter((c) => c.endpoint !== claim.endpoint), claim];
    return { value: { endpoints }, result: earlier };
  });
}
