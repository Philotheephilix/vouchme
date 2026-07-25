import { encodeFunctionData, decodeAbiParameters } from "viem";

const RESOLVE_ABI = [
  { name: "resolve", type: "function", stateMutability: "view", inputs: [{ name: "name", type: "bytes" }, { name: "data", type: "bytes" }], outputs: [{ name: "result", type: "bytes" }] },
];
const TEXT_ABI = { name: "text", type: "function", stateMutability: "view", inputs: [{ name: "node", type: "bytes32" }, { name: "key", type: "string" }], outputs: [{ name: "value", type: "string" }] };
const ADDR_ABI = { name: "addr", type: "function", stateMutability: "view", inputs: [{ name: "node", type: "bytes32" }], outputs: [{ name: "value", type: "address" }] };

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

const GATEWAY = "http://127.0.0.1:8899";
const SENDER = "0x" + "0".repeat(36) + "dead";
const NODE = "0x" + "00".repeat(32);
const name = process.argv[2];
const labels = name.split(".");
const nameHex = bytesToHex(encodeDnsName(labels));

const keys = [
  "aval.score",
  "aval.tier",
  "aval.depth",
  "aval.credential",
  "aval.anchor",
  "aval.vouches.in",
  "aval.vouches.out",
  "aval.expires",
  "aval.subgraph",
  "aval.path",
];

console.log(`Resolving ${name} via CCIP-Read gateway at ${GATEWAY}\n`);

for (const key of keys) {
  const innerData = encodeFunctionData({ abi: [TEXT_ABI], functionName: "text", args: [NODE, key] });
  const outerData = encodeFunctionData({ abi: RESOLVE_ABI, functionName: "resolve", args: [nameHex, innerData] });
  const url = `${GATEWAY}/${SENDER}/${outerData}.json`;
  const res = await fetch(url);
  if (!res.ok) {
    console.log(key.padEnd(20), "= <error>", res.status, await res.text());
    continue;
  }
  const body = await res.json();
  const [resultBytes] = decodeAbiParameters([{ type: "bytes" }, { type: "uint64" }, { type: "bytes" }], body.data);
  const [value] = decodeAbiParameters([{ type: "string" }], resultBytes);
  console.log(key.padEnd(20), "=", JSON.stringify(value));
}

// addr()
{
  const innerData = encodeFunctionData({ abi: [ADDR_ABI], functionName: "addr", args: [NODE] });
  const outerData = encodeFunctionData({ abi: RESOLVE_ABI, functionName: "resolve", args: [nameHex, innerData] });
  const url = `${GATEWAY}/${SENDER}/${outerData}.json`;
  const res = await fetch(url);
  if (res.ok) {
    const body = await res.json();
    const [resultBytes] = decodeAbiParameters([{ type: "bytes" }, { type: "uint64" }, { type: "bytes" }], body.data);
    const [addr] = decodeAbiParameters([{ type: "address" }], resultBytes);
    console.log("addr()".padEnd(20), "=", addr);
  } else {
    console.log("addr()".padEnd(20), "= <error>", res.status, await res.text());
  }
}
