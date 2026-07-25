// THROWAWAY: third-party resolution check — viem's getEnsAddress through the ENS UniversalResolver.
// Nothing in this file is Aval/VouchMe code: viem picks the resolver from its own sepolia chain
// config and does the wire format itself.
import { createPublicClient, http } from "viem";
import { sepolia } from "viem/chains";
const RPC = process.env.RPC_OVERRIDE ?? "https://sepolia.gateway.tenderly.co";
const c = createPublicClient({ chain: sepolia, transport: http(RPC) });
console.log(`viem ${(await import("viem/package.json", { with: { type: "json" } })).default.version}  chain sepolia  UniversalResolver ${sepolia.contracts.ensUniversalResolver.address}`);
console.log(`RPC ${RPC}  head ${await c.getBlockNumber()}\n`);
for (const name of process.argv.slice(2)) {
  try {
    const a = await c.getEnsAddress({ name });
    console.log(`getEnsAddress("${name}") = ${a ?? "null"}`);
  } catch (e) {
    console.log(`getEnsAddress("${name}") THREW: ${(e?.shortMessage ?? e?.message ?? String(e)).split("\n")[0]}`);
  }
}
