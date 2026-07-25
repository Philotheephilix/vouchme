#!/usr/bin/env node
// substreams/scripts/verify-mainnet.mjs
//
// The independent cross-check for substreams/PROOF.md §9.
//
// Streams NOTHING. This is plain JSON-RPC `eth_getLogs` against World Chain mainnet — a
// completely different data plane from StreamingFast's Firehose, with a different provider,
// different transport and different credentials (none). Its whole job is to answer, without
// trusting the Substreams stack at all: *which VouchMeRegistry events actually exist on chain 480,
// and what do their bytes decode to?*
//
// Run it next to `substreams run ./substreams.yaml map_trust_events -e worldchain -s 32833177
// -t +<n> -o jsonl` and compare. If the two disagree about an address, a tx hash, a block
// number or a timestamp, one of them is wrong and the pipeline is not to be trusted.
//
//   node substreams/scripts/verify-mainnet.mjs
//   RPC=https://... node substreams/scripts/verify-mainnet.mjs
//
// Dependency-free (node's built-in fetch). No key required — the default RPC is public.

const RPC = process.env.RPC || "https://worldchain-mainnet.g.alchemy.com/public";

// The live World Chain mainnet deployment. NOT deployments/worldchain-mainnet.json's
// `contracts.VouchMeRegistry` (0x7a294C7C…) — that file records an earlier, abandoned run of the
// same deploy script. This is the address app/.env.local reads, the address
// vouchme-trust/substreams.yaml indexes, and the only one carrying the real Vouched log.
const REGISTRY = "0x6fEfEf2d44203300a6a33d631840C972181b8722";
const DEPLOY_BLOCK = 32833177; // creation block, pinned by the deploy receipt + eth_getCode

// The same topic0 hashes vouchme-trust/substreams.yaml's params carry, and the same ones
// vouchme-trust/src/lib.rs's tests assert against. Recompute any of them with:
//   cast keccak "Vouched(address,address,uint64,uint64)"
const TOPICS = {
  "0x21f09afe14df68eeb2c0fd22ba443b93b0e63d090521d32444903f1d1277793f": "Enrolled",
  "0x1023f6bd7654e275f0ff5868480691e3f5feb9960e997af34f0cf9e4b33e22b9": "Vouched",
  "0x9089bae040c16337c6e96ac1661dba8c85c8b076f44d68407b4fa00243c05db7": "Reaffirmed",
  "0xb1c57350b08a198ff1a7862eeb3246e35fa3fc8e954bc691997ce37da018cbc7": "Revoked",
};

// This public Alchemy endpoint caps eth_getLogs at a 100-block window and says so in its error
// body ("You can make eth_getLogs requests with up to a 100 block range"), so paginate.
const CHUNK = 100;

async function rpc(method, params) {
  const res = await fetch(RPC, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  const body = await res.json();
  if (body.error) throw new Error(`${method}: ${JSON.stringify(body.error)}`);
  return body.result;
}

const addr = (topic) => "0x" + topic.slice(26);
const word = (data, i) => BigInt("0x" + data.slice(2 + i * 64, 2 + (i + 1) * 64));

/** ABI dynamic-`string` tail: word[i] is a byte offset into `data`; the word there is the length. */
function abiString(data, wordIndex) {
  const off = Number(word(data, wordIndex)) * 2 + 2;
  const len = Number(BigInt("0x" + data.slice(off, off + 64)));
  return Buffer.from(data.slice(off + 64, off + 64 + len * 2), "hex").toString("utf8");
}

const head = Number(BigInt(await rpc("eth_blockNumber", [])));
console.log(`rpc            ${RPC}`);
console.log(`chainId        ${Number(BigInt(await rpc("eth_chainId", [])))}`);
console.log(`registry       ${REGISTRY}`);
console.log(`range          ${DEPLOY_BLOCK} .. ${head}  (${head - DEPLOY_BLOCK + 1} blocks)\n`);

const logs = [];
for (let from = DEPLOY_BLOCK; from <= head; from += CHUNK) {
  const to = Math.min(from + CHUNK - 1, head);
  let got;
  for (let attempt = 0; ; attempt++) {
    try {
      got = await rpc("eth_getLogs", [
        { address: REGISTRY, fromBlock: "0x" + from.toString(16), toBlock: "0x" + to.toString(16) },
      ]);
      break;
    } catch (err) {
      if (attempt >= 5) throw err;
      await new Promise((r) => setTimeout(r, 800 * (attempt + 1)));
    }
  }
  logs.push(...got);
}

const counts = { Enrolled: 0, Vouched: 0, Reaffirmed: 0, Revoked: 0 };
const decoded = [];
for (const log of logs) {
  const name = TOPICS[log.topics[0]];
  if (!name) continue; // ownership/admin events — not part of the trust-graph event shape
  counts[name] += 1;
  const common = {
    event: name,
    blockNum: Number(BigInt(log.blockNumber)),
    txHash: log.transactionHash,
    logIndex: Number(BigInt(log.logIndex)),
  };
  if (name === "Vouched") {
    const issuedAt = Number(word(log.data, 0));
    const expiresAt = Number(word(log.data, 1));
    decoded.push({
      ...common,
      from: addr(log.topics[1]),
      to: addr(log.topics[2]),
      issuedAt,
      expiresAt,
      expiryDays: (expiresAt - issuedAt) / 86400,
    });
  } else if (name === "Enrolled") {
    decoded.push({
      ...common,
      account: addr(log.topics[1]),
      nullifierHash: log.topics[2],
      handle: abiString(log.data, 2),
      credentialExpiresAt: Number(word(log.data, 1)),
    });
  } else {
    decoded.push({ ...common, from: addr(log.topics[1]), to: addr(log.topics[2]), at: Number(word(log.data, 0)) });
  }
}

console.log("counts (topic0-filtered, whole deployed lifetime):");
for (const [k, v] of Object.entries(counts)) console.log(`  ${k.padEnd(11)} ${v}`);
console.log(`\n${decoded.length} decoded events — compare these byte-for-byte with substreams run:\n`);
for (const d of decoded) console.log(JSON.stringify(d));

const edges = counts.Vouched + counts.Reaffirmed + counts.Revoked;
console.log(
  `\nmap_trust_events should emit exactly ${edges} TrustEvent(s) over this range ` +
    `(Enrolled is account context, not an edge — it has no Kind in trust_graph.proto and no ` +
    `topic0 in the shipped params, so the module skips it by design).`
);
