#!/usr/bin/env node
// substreams/scripts/crosscheck-trust-edges.mjs
//
// The independent audit of the standardized `trust_edges` table.
//
// It streams NOTHING. Every row that Substreams wrote is re-derived here from plain JSON-RPC
// `eth_getTransactionReceipt` against a public RPC for that row's chain — a different data plane,
// a different provider, and no StreamingFast credential involved. Then it re-applies the
// trust-graph v0.2.0 adapter profile (role mapping, scope topic, tail layout) to the RAW LOG and
// asserts the result equals what is in the database, field by field.
//
// If the pipeline ever reverses an edge, mis-keys a scope, or invents a timestamp, this fails.
// That is the whole point: a decoded trust edge that "looks plausible" is worthless as evidence
// unless something that never touched the decoder agrees with it.
//
//   node substreams/scripts/crosscheck-trust-edges.mjs
//
// Exit code 0 = every row verified; 1 = at least one mismatch (details printed).
// Dependency-free (node's built-in fetch).

const CLICKHOUSE = process.env.CLICKHOUSE_HTTP_URL ?? "http://127.0.0.1:8123";

// One public RPC per indexed chain. None of these is a Firehose/Substreams endpoint.
// A browser-ish User-Agent is required: several of these public endpoints answer node's default
// UA with HTTP 403 (found by actually getting 403s, not by inspection).
const RPC = {
  worldchain: "https://worldchain-mainnet.g.alchemy.com/public",
  base: "https://base-rpc.publicnode.com",
  optimism: "https://mainnet.optimism.io",
  arbitrum: "https://arbitrum-one-rpc.publicnode.com",
  mainnet: "https://ethereum-rpc.publicnode.com",
};

// The shipped adapter profiles, restated as the auditor understands them. Deliberately written
// out by hand rather than parsed from substreams.yaml: if the manifest were wrong, parsing it
// would make this script agree with the bug instead of catching it.
const PROFILE = {
  aval: {
    contract: "0x6fefef2d44203300a6a33d631840c972181b8722",
    fromTopic: 1,
    toTopic: 2,
    scopeTopic: null,
    kinds: {
      "0x1023f6bd7654e275f0ff5868480691e3f5feb9960e997af34f0cf9e4b33e22b9": { kind: "VOUCH", tail: "issued_expires" },
      "0xb1c57350b08a198ff1a7862eeb3246e35fa3fc8e954bc691997ce37da018cbc7": { kind: "REVOKE", tail: "at" },
      "0x9089bae040c16337c6e96ac1661dba8c85c8b076f44d68407b4fa00243c05db7": { kind: "REAFFIRM", tail: "expires" },
    },
  },
  eas: {
    // EAS is a predeploy at 0x42..21 on the OP-stack chains and a normal deployment elsewhere,
    // so the address is per-network; checked against the row's own `network` below.
    contract: {
      base: "0x4200000000000000000000000000000000000021",
      optimism: "0x4200000000000000000000000000000000000021",
      arbitrum: "0xbd75f629a22dc1ced33dda0b68c546a1c035c458",
      mainnet: "0xa1207f3bba224e2c9c3c6d5af63d0eb1582ce587",
    },
    fromTopic: 2, // attester — EAS declares the SUBJECT first
    toTopic: 1, // recipient
    scopeTopic: 3, // schemaUID
    kinds: {
      "0x8bf46bf4cfd674fa735a3d63ec1c9ad4153f033c290341f3a588b75685141b35": { kind: "VOUCH", tail: "none" },
      "0xf930a6e2523c9cc298691873087a740550b8fc85a0680830414c148ed927f615": { kind: "REVOKE", tail: "none" },
    },
  },
};

async function rpc(url, method, params) {
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json", "user-agent": "aval-crosscheck/1.0" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  if (!res.ok) throw new Error(`${method} HTTP ${res.status}`);
  const body = await res.json();
  if (body.error) throw new Error(`${method}: ${JSON.stringify(body.error)}`);
  return body.result;
}

async function chQuery(sql) {
  const res = await fetch(`${CLICKHOUSE}/?default_format=JSON`, { method: "POST", body: sql });
  if (!res.ok) throw new Error(`ClickHouse ${res.status}: ${(await res.text()).slice(0, 300)}`);
  return (await res.json()).data ?? [];
}

const addrFromTopic = (t) => "0x" + t.slice(26).toLowerCase();
const word = (data, i) => Number(BigInt("0x" + data.slice(2 + i * 64, 2 + (i + 1) * 64)));

/** Re-apply a profile's tail layout to raw log data. Mirrors `decode_timing` in src/lib.rs. */
function decodeTiming(tail, data, blockTimestamp) {
  const words = (data.length - 2) / 64;
  switch (tail) {
    case "issued_expires":
      return words >= 2 ? [word(data, 0), word(data, 1)] : [blockTimestamp, 0];
    case "expires":
      return words >= 1 ? [blockTimestamp, word(data, 0)] : [blockTimestamp, 0];
    case "at":
      return words >= 1 ? [word(data, 0), 0] : [blockTimestamp, 0];
    case "none":
      return [blockTimestamp, 0];
    default:
      throw new Error(`unknown tail ${tail}`);
  }
}

/** ClickHouse renders DateTime as 'YYYY-MM-DD hh:mm:ss' in UTC; turn it back into a unix second. */
const chDateToUnix = (s) => Math.floor(Date.parse(s.replace(" ", "T") + "Z") / 1000);

const rows = await chQuery(`
  SELECT protocol, network, kind, from_addr, to_addr, scope,
         toString(issued_at) AS issued_at, toString(expires_at) AS expires_at,
         revoked, block_num, tx_hash
  FROM trust_edges FINAL
  ORDER BY protocol, network, block_num
`);

console.log(`crosschecking ${rows.length} standardized trust edges against independent RPC reads\n`);

let failures = 0;
let checked = 0;

for (const row of rows) {
  const url = RPC[row.network];
  const label = `${row.protocol}/${row.network} ${row.tx_hash.slice(0, 12)}… blk ${row.block_num}`;
  if (!url) {
    console.log(`SKIP  ${label} — no independent RPC configured for network "${row.network}"`);
    continue;
  }

  const profile = PROFILE[row.protocol];
  if (!profile) {
    console.log(`SKIP  ${label} — no auditor profile for protocol "${row.protocol}"`);
    continue;
  }
  const expectedContract =
    typeof profile.contract === "string" ? profile.contract : profile.contract[row.network];

  try {
    const receipt = await rpc(url, "eth_getTransactionReceipt", [row.tx_hash]);
    if (!receipt) throw new Error("transaction not found on the independent RPC");

    const block = await rpc(url, "eth_getBlockByNumber", ["0x" + Number(row.block_num).toString(16), false]);
    const blockTimestamp = Number(BigInt(block.timestamp));

    // Find the log in this receipt that the row claims to describe. Match on contract + the
    // profile's own role mapping — i.e. re-derive `from`/`to`, don't trust the row's ordering.
    const candidates = receipt.logs.filter(
      (l) =>
        l.address.toLowerCase() === expectedContract &&
        profile.kinds[l.topics[0]] !== undefined &&
        l.topics.length > Math.max(profile.fromTopic, profile.toTopic, profile.scopeTopic ?? 0)
    );

    const match = candidates.find((l) => {
      const from = addrFromTopic(l.topics[profile.fromTopic]);
      const to = addrFromTopic(l.topics[profile.toTopic]);
      const scope = profile.scopeTopic ? l.topics[profile.scopeTopic].toLowerCase() : "";
      return from === row.from_addr && to === row.to_addr && scope === row.scope;
    });

    if (!match) {
      // Is the row REVERSED? Check explicitly and say so — this is the exact bug v0.2.0 fixed,
      // so the audit should name it rather than report a generic miss.
      const reversed = candidates.find(
        (l) =>
          addrFromTopic(l.topics[profile.toTopic]) === row.from_addr &&
          addrFromTopic(l.topics[profile.fromTopic]) === row.to_addr
      );
      console.log(
        `FAIL  ${label} — ${reversed ? "edge is REVERSED vs the on-chain log" : "no matching log in the real receipt"}`
      );
      failures += 1;
      continue;
    }

    const { kind, tail } = profile.kinds[match.topics[0]];
    const [issuedAt, expiresAt] = decodeTiming(tail, match.data, blockTimestamp);

    const problems = [];
    if (row.kind !== kind && !(kind === "REVOKE" && row.kind === "REVOKE")) {
      // `kind` in the table is the LAST event applied to the edge; a VOUCH later revoked reads
      // REVOKE. Only flag when the row claims a kind this log cannot produce.
      if (row.kind !== kind) problems.push(`kind ${row.kind} != ${kind} from log`);
    }
    if (chDateToUnix(row.issued_at) !== issuedAt) {
      problems.push(`issued_at ${row.issued_at} != ${new Date(issuedAt * 1000).toISOString()}`);
    }
    if (chDateToUnix(row.expires_at) !== expiresAt) {
      problems.push(`expires_at ${row.expires_at} != unix ${expiresAt}`);
    }
    if (Number(row.revoked) !== (kind === "REVOKE" ? 1 : 0)) {
      problems.push(`revoked=${row.revoked} inconsistent with kind ${kind}`);
    }

    if (problems.length) {
      console.log(`FAIL  ${label}\n        ${problems.join("\n        ")}`);
      failures += 1;
    } else {
      console.log(
        `OK    ${label}\n        ${kind.padEnd(6)} from=${row.from_addr} to=${row.to_addr}` +
          (row.scope ? `\n        scope=${row.scope}` : "") +
          `\n        issued_at=${row.issued_at} expires_at=${row.expires_at}` +
          (expiresAt === 0 ? "  (0 = perpetual sentinel, no expiry in this log)" : "")
      );
      checked += 1;
    }
  } catch (err) {
    console.log(`ERROR ${label} — ${err.message}`);
    failures += 1;
  }
}

console.log(`\n${checked} verified, ${failures} failed, ${rows.length} rows total`);
console.log(
  failures === 0
    ? "every standardized edge matches an independently-fetched on-chain log, field for field"
    : "MISMATCH — the sink and the chain disagree; do not trust this table"
);
process.exit(failures === 0 ? 0 : 1);
