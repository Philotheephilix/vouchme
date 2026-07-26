import type { VouchMeMeta } from "@vouchme/minikit-sdk";

/**
 * Where the number came from.
 *
 * VouchMe attaches `subgraphDeployment` + `computedAtBlock` to every response precisely so an
 * integrator can show this (docs/07-app-api.md §3, docs/06-mcp-skills.md §3). Fiar is charging
 * someone a different price because of their reputation; the least it can do is let them check the
 * reading it charged them on.
 */
export function Provenance({ meta }: { meta: VouchMeMeta | null }) {
  if (!meta) return null;
  return (
    <p className="font-typed text-2xs leading-relaxed text-ink-soft">
      Priced from VouchMe {meta.subgraphDeployment} at block {meta.computedAtBlock.toLocaleString("en-US")}
      {meta.chainId ? ` · chain ${meta.chainId}` : ""} · engine {meta.engineVersion}
      {meta.mode === "fixture" ? " · fixture graph" : ""}
    </p>
  );
}
