// Drives the gateway's real ERC-3668 CCIP-Read HTTP endpoint the way an ENS client would:
// builds outer resolve(bytes name, bytes data) calldata wrapping an inner text(node,key)/addr(node)
// call, GETs /{sender}/{data}.json, and decodes the signed response.

import {
  encodeFunctionData,
  decodeAbiParameters,
  namehash,
  toHex,
} from "viem";

const GATEWAY = "http://127.0.0.1:8823";
const SENDER = "0x5c6ffd69d636756b6bdb9d2c51f1dae289b63db9"; // any valid (lowercase) address; unused for computation

const RESOLVE_ABI = [
  {
    name: "resolve",
    type: "function",
    stateMutability: "view",
    inputs: [
      { name: "name", type: "bytes" },
      { name: "data", type: "bytes" },
    ],
    outputs: [{ name: "result", type: "bytes" }],
  },
];

const TEXT_ABI = [
  {
    name: "text",
    type: "function",
    stateMutability: "view",
    inputs: [
      { name: "node", type: "bytes32" },
      { name: "key", type: "string" },
    ],
    outputs: [{ name: "value", type: "string" }],
  },
];

const ADDR_ABI = [
  {
    name: "addr",
    type: "function",
    stateMutability: "view",
    inputs: [{ name: "node", type: "bytes32" }],
    outputs: [{ name: "value", type: "address" }],
  },
];

function encodeDnsName(labels) {
  const parts = [];
  for (const label of labels) {
    const bytes = new TextEncoder().encode(label);
    parts.push(bytes.length, ...bytes);
  }
  parts.push(0);
  return new Uint8Array(parts);
}

function bytesToHex(bytes) {
  return "0x" + Buffer.from(bytes).toString("hex");
}

async function ccipCall(labels, kind, key) {
  const name = labels.join(".");
  const node = namehash(name);
  const innerData =
    kind === "text"
      ? encodeFunctionData({ abi: TEXT_ABI, functionName: "text", args: [node, key] })
      : encodeFunctionData({ abi: ADDR_ABI, functionName: "addr", args: [node] });

  const dnsName = bytesToHex(encodeDnsName(labels));
  const outerData = encodeFunctionData({ abi: RESOLVE_ABI, functionName: "resolve", args: [dnsName, innerData] });

  const url = `${GATEWAY}/${SENDER}/${outerData}.json`;
  const res = await fetch(url);
  const status = res.status;
  const body = await res.json();
  if (status !== 200) {
    return { status, error: body };
  }
  const [result, expires, sig] = decodeAbiParameters(
    [{ type: "bytes" }, { type: "uint64" }, { type: "bytes" }],
    body.data,
  );
  if (kind === "text") {
    const [value] = decodeAbiParameters([{ type: "string" }], result);
    return { status, value, expires: expires.toString(), sig };
  } else {
    const [addr] = decodeAbiParameters([{ type: "address" }], result);
    return { status, value: addr, expires: expires.toString(), sig };
  }
}

const NAME_LABELS = process.argv[2].split(".");
const KEYS = [
  "aval.score",
  "aval.tier",
  "aval.depth",
  "aval.credential",
  "aval.anchor",
  "aval.vouches.in",
  "aval.vouches.out",
  "aval.expires",
  "aval.path",
  "aval.subgraph",
];

console.log(`=== Real CCIP-Read (ERC-3668) HTTP resolution of "${NAME_LABELS.join(".")}" via ${GATEWAY} ===\n`);

const addrResult = await ccipCall(NAME_LABELS, "addr");
console.log(`addr(${NAME_LABELS.join(".")}) -> ${JSON.stringify(addrResult)}\n`);

for (const key of KEYS) {
  const r = await ccipCall(NAME_LABELS, "text", key);
  console.log(`text("${key}") -> ${JSON.stringify(r.value ?? r)}`);
}
