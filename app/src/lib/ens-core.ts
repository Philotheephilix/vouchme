/**
 * app/src/lib/ens-core.ts
 *
 * The ENSv2 primitives for `aval.eth` on Ethereum Sepolia, with no Next.js / env coupling, so the
 * exact same code path drives both the app (`app/src/lib/ens.ts`) and the operational scripts
 * (`scripts/dev/ens-provision.mts`). Nothing here reads `process.env`; callers supply the clients.
 *
 * docs/04-ens.md §7: "a member = a `PermissionedRegistry` they own". That is taken literally:
 *   • Every member label under `aval.eth` owns a real `PermissionedRegistry` clone, deployed
 *     through the shared `VerifiableFactory`, at a CREATE2 address derived from the label alone.
 *   • That clone is what `Entry.subregistry` points at — never the zero address, never a shared
 *     registry, never simulated above the chain.
 *   • A vouch from `alice` to `carol` is `register("carol", …)` **inside alice's own registry**,
 *     whose own `Entry.subregistry` is carol's registry — so `erin.carol.alice.aval.eth` is one
 *     more `getSubregistry` hop, exactly as docs/04-ens.md §7.1 describes.
 *
 * Every address below is from `deployments/ens-sepolia.json`, each one live-read or Sourcify
 * exact_match verified. The clone-address derivation was reverse-derived from, and checked
 * against, the real `aval.eth` registry clone (see `predictMemberRegistryAddress`).
 */

import {
  concat,
  encodeAbiParameters,
  encodeFunctionData,
  getCreate2Address,
  keccak256,
  namehash,
  toBytes,
  type Account,
  type Address,
  type Chain,
  type Hex,
  type PublicClient,
  type Transport,
  type WalletClient,
} from "viem";

// ── deployed addresses (deployments/ens-sepolia.json) ─────────────────────────────────────────

/** `aval.eth`'s own `PermissionedRegistry` clone — the depth-1 registry every member lives in. */
export const AVAL_ETH_REGISTRY: Address = "0xb8C3d3AD86b0b66CE5401c81e9c4a037DF69eF33";
/** Shared `PermissionedResolver` clone (Sourcify exact_match on its implementation). */
export const AVAL_ETH_RESOLVER: Address = "0x211D6CC339C7C6E4B4448c04cD034E363d9994d3";
export const DEPLOYER_ADDRESS: Address = "0x69827C0FEF274C63Ac4806106F2BA544E6129050";
/** `VerifiableFactory.deployProxy(address implementation, uint256 salt, bytes data)` — 0x5d84121a. */
export const VERIFIABLE_FACTORY: Address = "0xD2a632D8a8b67c2c4398c255CbD7aF8dd7236198";
/** The factory's immutable clone target; every proxy it deploys is an EIP-1167 stub onto this. */
export const PROXY_LOGIC: Address = "0x917c561a74df398646E06f3ffAA51DB8E8330c5A";
/** `PermissionedRegistry` implementation behind the `aval.eth` clone — reused for every member. */
export const MEMBER_REGISTRY_IMPLEMENTATION: Address = "0x0F99e7Ea74903AfCB7224d0354fD7428A6f92917";

export const ZERO_ADDRESS: Address = "0x0000000000000000000000000000000000000000";

/** `RegistryRolesLib`'s 64-slot nybble-packed roles bitmap, every nybble set — read back from
 *  `avalRegistry.roles(ROOT_RESOURCE=0, deployer)` on chain, not a guess at what "all roles" means. */
export const ALL_ROLES = 0x1111111111111111111111111111111111111111111111111111111111111111n;

/**
 * The role that gates ERC-1155 transfers (docs/04-ens.md §7.2).
 *
 * The docs call it `ROLE_CAN_TRANSFER`. **That constant does not exist in the deployed contract.**
 * The Sourcify `exact_match` source of the `.eth` registry
 * (`0xDEDB92913A25abE1f7BCDD85D8A344a43B398B67`, which shares `PermissionedRegistry` with every
 * clone here) declares only the *admin* half, at
 * `project/src/registry/libraries/RegistryRolesLib.sol:45`:
 *
 *     /// @dev Nybble 7: authorizes ERC1155 token transfers. Root or token.
 *     ///      This role is only checked on the token owner, not the operator.
 *     uint256 internal constant ROLE_CAN_TRANSFER_ADMIN = (1 << 28) << 128;
 *
 * and `PermissionedRegistry._update()` (`PermissionedRegistry.sol:501-505`) gates every transfer on
 * exactly that bit:
 *
 *     // only check ROLE_CAN_TRANSFER_ADMIN on original owner (from)
 *     if (!hasRoles(tokenId, RegistryRolesLib.ROLE_CAN_TRANSFER_ADMIN, from)) {
 *         revert TransferDisallowed(tokenId, from);
 *     }
 *
 * Nybble 7 shifted into the admin half is bit 156. Confirmed empirically as well — see
 * `SOULBOUND_ROLES` — because the clone implementation is not source-verified.
 */
export const ROLE_CAN_TRANSFER_ADMIN = (1n << 28n) << 128n; // 1 << 156

/** `ROLE_REGISTRAR` — nybble 0. Required on `ROOT_RESOURCE` to call `register()`. */
export const ROLE_REGISTRAR = 1n;

/**
 * What every Aval name is minted with: everything except the ability to transfer the token.
 *
 *     0x1111111111111111111111110111111111111111111111111111111111111111
 *                              ↑ nybble 39 (= nybble 7 + 32 admin offset) cleared
 *
 * **The bitmap alone is not enough.**
 * `EnhancedAccessControl.hasRoles()` (`EnhancedAccessControl.sol:187-195`) ORs the account's roles
 * on the resource with its roles on `ROOT_RESOURCE`:
 *
 *     return (_roles[ROOT_RESOURCE][account] | _roles[resource][account]) & roleBitmap == roleBitmap;
 *
 * Aval's names are all owned by the deployer, who holds `ALL_ROLES` on every registry's root. So a
 * token minted with this bitmap is **still transferable** until the root grant is cleared too —
 * see `ensureRegistrySoulbound`.
 */
export const SOULBOUND_ROLES = ALL_ROLES & ~ROLE_CAN_TRANSFER_ADMIN;

/** Member names are registered for a year; vouch subnames match `AvalRegistry.VOUCH_EXPIRY`. */
export const MEMBER_NAME_TTL_SECONDS = 365n * 24n * 60n * 60n;
export const VOUCH_NAME_TTL_SECONDS = 90n * 24n * 60n * 60n;

// ── ABIs ──────────────────────────────────────────────────────────────────────────────────────

/** Subset of `PermissionedRegistry`, taken from the Sourcify-verified `.eth` registry source at
 *  `0xDEDB92913A25abE1f7BCDD85D8A344a43B398B67`, all of it present in the clone implementation. */
export const REGISTRY_ABI = [
  {
    type: "function",
    name: "register",
    stateMutability: "nonpayable",
    inputs: [
      { name: "label", type: "string" },
      { name: "owner", type: "address" },
      { name: "registry", type: "address" },
      { name: "resolver", type: "address" },
      { name: "roleBitmap", type: "uint256" },
      { name: "expiry", type: "uint64" },
    ],
    outputs: [{ name: "tokenId", type: "uint256" }],
  },
  {
    type: "function",
    name: "setSubregistry",
    stateMutability: "nonpayable",
    inputs: [
      { name: "anyId", type: "uint256" },
      { name: "registry", type: "address" },
    ],
    outputs: [],
  },
  {
    type: "function",
    name: "findTokenId",
    stateMutability: "view",
    inputs: [{ name: "label", type: "string" }],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    type: "function",
    name: "findOwner",
    stateMutability: "view",
    inputs: [{ name: "label", type: "string" }],
    outputs: [{ name: "", type: "address" }],
  },
  {
    type: "function",
    name: "getSubregistry",
    stateMutability: "view",
    inputs: [{ name: "label", type: "string" }],
    outputs: [{ name: "", type: "address" }],
  },
  {
    type: "function",
    name: "getResolver",
    stateMutability: "view",
    inputs: [{ name: "label", type: "string" }],
    outputs: [{ name: "", type: "address" }],
  },
  {
    type: "function",
    name: "findExpiry",
    stateMutability: "view",
    inputs: [{ name: "label", type: "string" }],
    outputs: [{ name: "", type: "uint64" }],
  },
  {
    type: "function",
    name: "hasRoles",
    stateMutability: "view",
    inputs: [
      { name: "anyId", type: "uint256" },
      { name: "roleBitmap", type: "uint256" },
      { name: "account", type: "address" },
    ],
    outputs: [{ name: "", type: "bool" }],
  },
  {
    type: "function",
    name: "roles",
    stateMutability: "view",
    inputs: [
      { name: "anyId", type: "uint256" },
      { name: "account", type: "address" },
    ],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    type: "function",
    name: "hasRootRoles",
    stateMutability: "view",
    inputs: [
      { name: "roleBitmap", type: "uint256" },
      { name: "account", type: "address" },
    ],
    outputs: [{ name: "", type: "bool" }],
  },
  {
    type: "function",
    name: "getResource",
    stateMutability: "view",
    inputs: [{ name: "anyId", type: "uint256" }],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    type: "function",
    name: "revokeRootRoles",
    stateMutability: "nonpayable",
    inputs: [
      { name: "roleBitmap", type: "uint256" },
      { name: "account", type: "address" },
    ],
    outputs: [{ name: "", type: "bool" }],
  },
  {
    type: "function",
    name: "revokeRoles",
    stateMutability: "nonpayable",
    inputs: [
      { name: "resource", type: "uint256" },
      { name: "roleBitmap", type: "uint256" },
      { name: "account", type: "address" },
    ],
    outputs: [{ name: "", type: "bool" }],
  },
  {
    type: "function",
    name: "safeTransferFrom",
    stateMutability: "nonpayable",
    inputs: [
      { name: "from", type: "address" },
      { name: "to", type: "address" },
      { name: "id", type: "uint256" },
      { name: "value", type: "uint256" },
      { name: "data", type: "bytes" },
    ],
    outputs: [],
  },
  /** `IStandardRegistry.sol:34` — what a soulbound token reverts with. */
  {
    type: "error",
    name: "TransferDisallowed",
    inputs: [
      { name: "tokenId", type: "uint256" },
      { name: "from", type: "address" },
    ],
  },
] as const;

export const RESOLVER_ABI = [
  {
    type: "function",
    name: "setAddr",
    stateMutability: "nonpayable",
    inputs: [
      { name: "node", type: "bytes32" },
      { name: "a", type: "address" },
    ],
    outputs: [],
  },
  {
    type: "function",
    name: "addr",
    stateMutability: "view",
    inputs: [{ name: "node", type: "bytes32" }],
    outputs: [{ name: "", type: "address" }],
  },
] as const;

export const VERIFIABLE_FACTORY_ABI = [
  {
    type: "function",
    name: "deployProxy",
    stateMutability: "nonpayable",
    inputs: [
      { name: "implementation", type: "address" },
      { name: "salt", type: "uint256" },
      { name: "data", type: "bytes" },
    ],
    outputs: [{ name: "", type: "address" }],
  },
  {
    type: "event",
    name: "ProxyDeployed",
    inputs: [
      { name: "sender", type: "address", indexed: true },
      { name: "proxyAddress", type: "address", indexed: true },
      { name: "salt", type: "uint256", indexed: false },
      { name: "implementation", type: "address", indexed: false },
    ],
  },
] as const;

/** The clone's initializer, called through the factory in the same transaction as the deploy.
 *  Selector `0xcd6dc687`; the argument shape was read off the real `deployProxy` calldata that
 *  created the `aval.eth` registry clone (tx 0xd30a5d94…131a). */
export const REGISTRY_INITIALIZER_ABI = [
  {
    type: "function",
    name: "initialize",
    stateMutability: "nonpayable",
    inputs: [
      { name: "owner", type: "address" },
      { name: "roleBitmap", type: "uint256" },
    ],
    outputs: [],
  },
] as const;

// ── client types ──────────────────────────────────────────────────────────────────────────────

export type EnsPublicClient = PublicClient;
export type EnsWalletClient = WalletClient<Transport, Chain, Account>;
export interface EnsClients {
  publicClient: EnsPublicClient;
  walletClient: EnsWalletClient;
}

// ── errors ────────────────────────────────────────────────────────────────────────────────────

export class EnsConfigError extends Error {}

/** Thrown when `register()` succeeded but `setAddr()` reverted — the name exists but resolves to
 *  nothing. The caller is enrolled and their name is reserved; only the pointer write failed, and
 *  retrying should redo `setAddr` only, never `register` again (it would revert — already taken). */
export class EnsMintPartialError extends Error {
  label: string;
  registerTxHash: Hex | null;
  setAddrTxHash: Hex;
  constructor(label: string, registerTxHash: Hex | null, setAddrTxHash: Hex) {
    super(`"${label}" was minted but the address record failed to write.`);
    this.name = "EnsMintPartialError";
    this.label = label;
    this.registerTxHash = registerTxHash;
    this.setAddrTxHash = setAddrTxHash;
  }
}

/** Thrown when a vouch cannot be expressed as a subname because the voucher has no registry of
 *  their own yet. The UI must say this plainly rather than claim a name was minted. */
export class EnsVouchNestingUnavailableError extends Error {
  voucherLabel: string;
  constructor(voucherLabel: string, reason: string) {
    super(reason);
    this.name = "EnsVouchNestingUnavailableError";
    this.voucherLabel = voucherLabel;
  }
}

// ── deterministic member-registry addressing ──────────────────────────────────────────────────

/**
 * Namespace for the per-member registry salt. The salt — and therefore the clone address — is a
 * pure function of the label, so any member's registry address can be recomputed offline from
 * their name alone, without a receipt, a database or a log scan.
 *
 *     salt(label)  = uint256(keccak256(utf8("aval.eth/member-registry/v1::" + label)))
 */
export const MEMBER_REGISTRY_SALT_NAMESPACE = "aval.eth/member-registry/v1";

export function memberRegistrySalt(label: string): bigint {
  return BigInt(keccak256(toBytes(`${MEMBER_REGISTRY_SALT_NAMESPACE}::${label}`)));
}

/**
 * The CREATE2 address `VerifiableFactory.deployProxy` will produce for `label`.
 *
 * Derivation, recovered by disassembling the real deployment of the `aval.eth` registry clone
 * (tx `0xd30a5d94…131a`) and confirmed to reproduce `0xb8C3d3AD…eF33` exactly:
 *
 *     outerSalt = keccak256(abi.encode(sender, salt))
 *     runtime   = 0x363d3d373d3d3d363d73 ‖ PROXY_LOGIC ‖ 0x5af43d82803e903d91602b57fd5bf3 ‖ outerSalt
 *     creation  = 0x3d604d80600a3d3981f3 ‖ runtime                       (ERC-1167 + 32B immutable arg)
 *     address   = CREATE2(VERIFIABLE_FACTORY, outerSalt, keccak256(creation))
 *
 * `outerSalt` also appears verbatim as the clone's appended immutable argument on chain, which is
 * an independent check that this derivation is the one the factory actually uses.
 */
export function predictMemberRegistryAddress(label: string, deployer: Address = DEPLOYER_ADDRESS): Address {
  const outerSalt = keccak256(
    encodeAbiParameters([{ type: "address" }, { type: "uint256" }], [deployer, memberRegistrySalt(label)]),
  );
  const creationCode = concat([
    "0x3d604d80600a3d3981f3363d3d373d3d3d363d73",
    PROXY_LOGIC,
    "0x5af43d82803e903d91602b57fd5bf3",
    outerSalt,
  ]);
  return getCreate2Address({ from: VERIFIABLE_FACTORY, salt: outerSalt, bytecodeHash: keccak256(creationCode) });
}

// ── low-level reads ───────────────────────────────────────────────────────────────────────────

export async function findOwner(client: EnsPublicClient, registry: Address, label: string): Promise<Address> {
  return client.readContract({ address: registry, abi: REGISTRY_ABI, functionName: "findOwner", args: [label] });
}

export async function getSubregistry(client: EnsPublicClient, registry: Address, label: string): Promise<Address> {
  return client.readContract({ address: registry, abi: REGISTRY_ABI, functionName: "getSubregistry", args: [label] });
}

export async function readAddrRecord(client: EnsPublicClient, name: string): Promise<Address | null> {
  const addr = await client.readContract({
    address: AVAL_ETH_RESOLVER,
    abi: RESOLVER_ABI,
    functionName: "addr",
    args: [namehash(name)],
  });
  return addr === ZERO_ADDRESS ? null : addr;
}

/** A registry address is only real if there is contract code at it. A `deployProxy` receipt on its
 *  own proves nothing about the address anyone later reads back. */
export async function hasContractCode(client: EnsPublicClient, address: Address): Promise<boolean> {
  if (address === ZERO_ADDRESS) return false;
  const code = await client.getCode({ address });
  return typeof code === "string" && code.length > 2;
}

// ── soulbound enforcement ─────────────────────────────────────────────────────────────────────

/**
 * Clears `ROLE_CAN_TRANSFER_ADMIN` from the deployer on `registry`'s `ROOT_RESOURCE`, so the root
 * grant can no longer be ORed in to satisfy the transfer check for *any* token in that registry.
 *
 * Idempotent: reads `hasRootRoles` first and sends nothing when the bit is already clear.
 *
 * **This is one-way.** `EnhancedAccessControl._getSettableRoles()` lets an account grant an admin
 * role only if it already holds that same admin role, and nybble 39 has no admin above it, so once
 * the last holder gives it up nobody can ever grant it again in this registry. That is deliberate:
 * docs/04-ens.md §7.2 says "Vouches are non-transferable, **always**", and an irreversible bit is
 * the only honest implementation of "always".
 *
 * Nothing else depends on this role. It appears exactly once in `PermissionedRegistry`, in the
 * `_update()` transfer gate. `register()`, `setSubregistry()`, `setResolver()`, `renew()` and the
 * burn+mint of `_regenerate()` are all unaffected — `_update()` skips its check when `from` or `to`
 * is the zero address, so mint and burn still work.
 */
export async function ensureRegistrySoulbound(clients: EnsClients, registry: Address): Promise<Hex | null> {
  const { publicClient, walletClient } = clients;
  const stillTransferable = await publicClient.readContract({
    address: registry,
    abi: REGISTRY_ABI,
    functionName: "hasRootRoles",
    args: [ROLE_CAN_TRANSFER_ADMIN, walletClient.account.address],
  });
  if (!stillTransferable) return null;

  const hash = await walletClient.writeContract({
    address: registry,
    abi: REGISTRY_ABI,
    functionName: "revokeRootRoles",
    args: [ROLE_CAN_TRANSFER_ADMIN, walletClient.account.address],
  });
  const receipt = await publicClient.waitForTransactionReceipt({ hash });
  if (receipt.status !== "success") {
    throw new Error(`revokeRootRoles(ROLE_CAN_TRANSFER_ADMIN) on ${registry} reverted: ${hash}`);
  }
  return hash;
}

/**
 * Retro-fit for a name minted with `ALL_ROLES` on its own token resource.
 * Clearing the root grant is not enough for those: `hasRoles` ORs the two, and the token resource
 * still carries the bit. This clears it there too.
 *
 * Returns `null` when the token is already soulbound or the label is unregistered.
 */
export async function makeExistingNameSoulbound(
  clients: EnsClients,
  registry: Address,
  label: string,
): Promise<Hex | null> {
  const { publicClient, walletClient } = clients;
  const owner = await findOwner(publicClient, registry, label);
  if (owner === ZERO_ADDRESS) return null;

  const tokenId = await publicClient.readContract({
    address: registry,
    abi: REGISTRY_ABI,
    functionName: "findTokenId",
    args: [label],
  });
  const transferable = await publicClient.readContract({
    address: registry,
    abi: REGISTRY_ABI,
    functionName: "hasRoles",
    args: [tokenId, ROLE_CAN_TRANSFER_ADMIN, owner],
  });
  if (!transferable) return null;

  const resource = await publicClient.readContract({
    address: registry,
    abi: REGISTRY_ABI,
    functionName: "getResource",
    args: [tokenId],
  });
  const hash = await walletClient.writeContract({
    address: registry,
    abi: REGISTRY_ABI,
    functionName: "revokeRoles",
    args: [resource, ROLE_CAN_TRANSFER_ADMIN, owner],
  });
  const receipt = await publicClient.waitForTransactionReceipt({ hash });
  if (receipt.status !== "success") {
    throw new Error(`revokeRoles(ROLE_CAN_TRANSFER_ADMIN) for "${label}" in ${registry} reverted: ${hash}`);
  }
  return hash;
}

/** True when the token for `label` in `registry` cannot be transferred by its owner. */
export async function isNameSoulbound(
  client: EnsPublicClient,
  registry: Address,
  label: string,
): Promise<boolean> {
  const owner = await findOwner(client, registry, label);
  if (owner === ZERO_ADDRESS) return false;
  const tokenId = await client.readContract({
    address: registry,
    abi: REGISTRY_ABI,
    functionName: "findTokenId",
    args: [label],
  });
  return !(await client.readContract({
    address: registry,
    abi: REGISTRY_ABI,
    functionName: "hasRoles",
    args: [tokenId, ROLE_CAN_TRANSFER_ADMIN, owner],
  }));
}

/**
 * The gate that stops a soulbound mint from being claimed but not true. Passing a different bitmap
 * to `register()` is not evidence of anything; only a live `hasRoles` read against the owner is.
 * Every mint path calls this and throws rather than return a result that says "minted".
 */
async function assertSoulbound(client: EnsPublicClient, registry: Address, label: string, name: string): Promise<void> {
  if (!(await isNameSoulbound(client, registry, label))) {
    throw new Error(
      `"${name}" is still transferable: its owner satisfies hasRoles(tokenId, ROLE_CAN_TRANSFER_ADMIN) in ${registry}. ` +
        `Refusing to report a soulbound mint that is not soulbound (docs/99-errata.md E-10).`,
    );
  }
}

// ── registry deployment ───────────────────────────────────────────────────────────────────────

export interface DeployedRegistry {
  address: Address;
  salt: bigint;
  /** `null` when the clone was already deployed at its deterministic address (idempotent replay). */
  deployTxHash: Hex | null;
  /** The `setSubregistry` that attached it to the parent entry, when this call had to do that. */
  attachTxHash: Hex | null;
  /** The root `ROLE_CAN_TRANSFER_ADMIN` revocation, when this call had to send it. */
  soulboundTxHash: Hex | null;
}

/**
 * Deploys `label`'s own `PermissionedRegistry` clone through the `VerifiableFactory`, or returns
 * the existing one. Idempotent by construction: the address is a pure function of the label, so a
 * re-run finds code already there and skips the write instead of colliding on CREATE2.
 *
 * The clone is initialized in the same transaction with `initialize(owner, SOULBOUND_ROLES)`,
 * mirroring how the `aval.eth` registry itself was created except that the root grant withholds
 * `ROLE_CAN_TRANSFER_ADMIN` — so a member's registry is born soulbound, with no follow-up
 * transaction, and every vouch minted inside it is non-transferable from its first block.
 * The initializer is not part of the CREATE2 preimage, so clone addresses are unchanged by this.
 *
 * Registries deployed without that root grant cleared are repaired in place by
 * `ensureRegistrySoulbound`.
 */
export async function deployMemberRegistry(
  clients: EnsClients,
  label: string,
  owner: Address = DEPLOYER_ADDRESS,
): Promise<DeployedRegistry> {
  const { publicClient, walletClient } = clients;
  const salt = memberRegistrySalt(label);
  const address = predictMemberRegistryAddress(label, walletClient.account.address);

  if (await hasContractCode(publicClient, address)) {
    const soulboundTxHash = await ensureRegistrySoulbound(clients, address);
    return { address, salt, deployTxHash: null, attachTxHash: null, soulboundTxHash };
  }

  const initData = encodeFunctionData({
    abi: REGISTRY_INITIALIZER_ABI,
    functionName: "initialize",
    args: [owner, SOULBOUND_ROLES],
  });
  const deployTxHash = await walletClient.writeContract({
    address: VERIFIABLE_FACTORY,
    abi: VERIFIABLE_FACTORY_ABI,
    functionName: "deployProxy",
    args: [MEMBER_REGISTRY_IMPLEMENTATION, salt, initData],
  });
  const receipt = await publicClient.waitForTransactionReceipt({ hash: deployTxHash });
  if (receipt.status !== "success") {
    throw new Error(`deployProxy for "${label}" reverted: ${deployTxHash}`);
  }
  if (!(await hasContractCode(publicClient, address))) {
    throw new Error(
      `deployProxy for "${label}" succeeded (${deployTxHash}) but there is no contract code at the predicted address ${address}.`,
    );
  }
  return { address, salt, deployTxHash, attachTxHash: null, soulboundTxHash: null };
}

// ── member names ──────────────────────────────────────────────────────────────────────────────

export interface MintResult {
  label: string;
  name: string;
  /** `null` when this call skipped `register()` because a prior attempt already completed it. */
  registerTxHash: Hex | null;
  setAddrTxHash: Hex | null;
  /** `null` when the member's registry clone already existed. */
  registryDeployTxHash: Hex | null;
  /** Set only when an already-registered label had to be backfilled with `setSubregistry`. */
  setSubregistryTxHash: Hex | null;
  /** The member's own registry, read back from `getSubregistry(label)` after all writes. */
  subregistry: Address | null;
  resolvedAddress: Address | null;
  /** The root/per-token `ROLE_CAN_TRANSFER_ADMIN` revocations this call had to send. */
  soulboundTxHashes: Hex[];
  /** True when nothing at all had to be written (idempotent replay). */
  alreadyComplete: boolean;
}

/**
 * Brings `<label>.aval.eth` to its complete, wired state and proves it by reading back:
 *   1. deploy `label`'s own `PermissionedRegistry` clone (skipped if already deployed),
 *   2. `register(label, deployer, thatRegistry, resolver, SOULBOUND_ROLES, expiry)` on the
 *      `aval.eth` registry — or, when the label already exists (`carol`, `dave`),
 *      `setSubregistry(tokenId, thatRegistry)` instead, because re-registering a taken label
 *      reverts,
 *   3. `setAddr(namehash("<label>.aval.eth"), targetAddress)` on the resolver,
 *   4. re-read `addr()`, `getSubregistry()` and `eth_getCode` and fail loudly if any is wrong,
 *   5. re-read `hasRoles(tokenId, ROLE_CAN_TRANSFER_ADMIN, owner)` and refuse to return at all if
 *      the name is still transferable.
 *
 * Step 3 is the one that makes the name resolve. "The transaction succeeded" and "the name
 * resolves" are different claims; only a live `addr()` read after the write is trusted here.
 */
export async function mintMemberName(
  clients: EnsClients,
  label: string,
  targetAddress: Address,
): Promise<MintResult> {
  const { publicClient, walletClient } = clients;
  const name = `${label}.aval.eth`;

  const registry = await deployMemberRegistry(clients, label);

  // The member-name token lives in the aval.eth registry, so that is the root grant that has to be
  // clear for it to be soulbound (see `SOULBOUND_ROLES` on why the bitmap alone is not enough).
  // One-way and idempotent; after the first member this is a no-op read.
  const soulboundTxHash = await ensureRegistrySoulbound(clients, AVAL_ETH_REGISTRY);

  const owner = await findOwner(publicClient, AVAL_ETH_REGISTRY, label);
  const alreadyRegistered = owner !== ZERO_ADDRESS;

  let registerTxHash: Hex | null = null;
  let setSubregistryTxHash: Hex | null = null;

  if (!alreadyRegistered) {
    const expiry = BigInt(Math.floor(Date.now() / 1000)) + MEMBER_NAME_TTL_SECONDS;
    registerTxHash = await walletClient.writeContract({
      address: AVAL_ETH_REGISTRY,
      abi: REGISTRY_ABI,
      functionName: "register",
      args: [label, DEPLOYER_ADDRESS, registry.address, AVAL_ETH_RESOLVER, SOULBOUND_ROLES, expiry],
    });
    const receipt = await publicClient.waitForTransactionReceipt({ hash: registerTxHash });
    if (receipt.status !== "success") throw new Error(`register("${label}") reverted: ${registerTxHash}`);
  } else {
    // Never re-register an existing label — `register()` reverts on a taken label. Backfill the
    // subregistry pointer instead.
    const current = await getSubregistry(publicClient, AVAL_ETH_REGISTRY, label);
    if (current.toLowerCase() !== registry.address.toLowerCase()) {
      const tokenId = await publicClient.readContract({
        address: AVAL_ETH_REGISTRY,
        abi: REGISTRY_ABI,
        functionName: "findTokenId",
        args: [label],
      });
      setSubregistryTxHash = await walletClient.writeContract({
        address: AVAL_ETH_REGISTRY,
        abi: REGISTRY_ABI,
        functionName: "setSubregistry",
        args: [tokenId, registry.address],
      });
      const receipt = await publicClient.waitForTransactionReceipt({ hash: setSubregistryTxHash });
      if (receipt.status !== "success") {
        throw new Error(`setSubregistry("${label}") reverted: ${setSubregistryTxHash}`);
      }
    }
  }

  const setAddrTxHash = await setAddrIfNeeded(clients, name, targetAddress, label, registerTxHash);

  // A name registered with ROLE_CAN_TRANSFER_ADMIN on its own token resource is not reached by
  // clearing the root grant above. Retro-fit those in place (no-op otherwise).
  const retroTxHash = await makeExistingNameSoulbound(clients, AVAL_ETH_REGISTRY, label);

  const resolvedAddress = await readAddrRecord(publicClient, name);
  const subregistry = await getSubregistry(publicClient, AVAL_ETH_REGISTRY, label);
  await assertWired(publicClient, name, subregistry, resolvedAddress, targetAddress);
  await assertSoulbound(publicClient, AVAL_ETH_REGISTRY, label, name);

  return {
    label,
    name,
    registerTxHash,
    setAddrTxHash,
    registryDeployTxHash: registry.deployTxHash,
    setSubregistryTxHash,
    subregistry,
    resolvedAddress,
    soulboundTxHashes: [registry.soulboundTxHash, soulboundTxHash, retroTxHash].filter((h): h is Hex => h !== null),
    alreadyComplete:
      registerTxHash === null && setAddrTxHash === null && registry.deployTxHash === null && setSubregistryTxHash === null,
  };
}

// ── vouch subnames (the nested name) ──────────────────────────────────────────────────────────

export interface VouchMintResult {
  /** e.g. `carol.alice.aval.eth`. */
  name: string;
  voucherLabel: string;
  voucheeLabel: string;
  voucherRegistry: Address;
  /** The child registry wired into the edge — the vouchee's own registry (`Entry.subregistry`). */
  voucheeRegistry: Address;
  /** Set only when the vouchee had no registry and this call had to create/attach one. */
  voucheeRegistryDeployTxHash: Hex | null;
  voucheeRegistryAttachTxHash: Hex | null;
  registerTxHash: Hex | null;
  setAddrTxHash: Hex | null;
  setSubregistryTxHash: Hex | null;
  resolvedAddress: Address | null;
  /** The `ROLE_CAN_TRANSFER_ADMIN` revocations this call had to send to make the vouch soulbound. */
  soulboundTxHashes: Hex[];
  alreadyComplete: boolean;
}

/**
 * Issues the vouch as a name: `register(voucheeLabel, …)` **inside the voucher's own registry**,
 * producing a real `<vouchee>.<voucher>.aval.eth` that resolves to the vouchee's address, with the
 * edge's `Entry.subregistry` pointing at the vouchee's own registry so the path keeps walking.
 *
 * The vouch token is minted **soulbound** — `SOULBOUND_ROLES`, plus a cleared root grant on the
 * voucher's registry, plus a `hasRoles` read-back that refuses to return if either was missed.
 * docs/04-ens.md §7.2: a vouch that can be transferred is a vouch that can be sold, and
 * docs/08-threat-model.md §5 names slot markets the design's weakest point.
 *
 * Throws `EnsVouchNestingUnavailableError` when the voucher has no registry of their own — the one
 * case where the product cannot honestly say "minted", and the UI is required to say so instead.
 */
export async function mintVouchSubname(
  clients: EnsClients,
  voucherLabel: string,
  voucheeLabel: string,
  voucheeAddress: Address,
): Promise<VouchMintResult> {
  const { publicClient, walletClient } = clients;

  const voucherRegistry = await getSubregistry(publicClient, AVAL_ETH_REGISTRY, voucherLabel);
  if (!(await hasContractCode(publicClient, voucherRegistry))) {
    throw new EnsVouchNestingUnavailableError(
      voucherLabel,
      `"${voucherLabel}.aval.eth" does not own a registry yet, so "${voucheeLabel}.${voucherLabel}.aval.eth" cannot be minted. The vouch itself is recorded on World Chain; only the nested ENS name is unavailable.`,
    );
  }

  // The vouch token lives in the VOUCHER's registry, so that is the root grant that has to be clear
  // for it to be soulbound. Without this the `SOULBOUND_ROLES` bitmap below is a no-op, because
  // `hasRoles` ORs the root grant in and the deployer owns the token (see `SOULBOUND_ROLES`).
  const voucherRegistrySoulboundTx = await ensureRegistrySoulbound(clients, voucherRegistry);

  // The trust edge is `Entry.subregistry` → the vouchee's own registry (docs/04-ens.md §7.1), so
  // the vouchee must have one. Self-healing: deploy + attach it if this is the first time.
  const vouchee = await mintOrEnsureVoucheeRegistry(clients, voucheeLabel);
  const voucheeRegistry = vouchee.address;

  const name = `${voucheeLabel}.${voucherLabel}.aval.eth`;
  const owner = await findOwner(publicClient, voucherRegistry, voucheeLabel);

  let registerTxHash: Hex | null = null;
  let setSubregistryTxHash: Hex | null = null;

  if (owner === ZERO_ADDRESS) {
    const expiry = BigInt(Math.floor(Date.now() / 1000)) + VOUCH_NAME_TTL_SECONDS;
    registerTxHash = await walletClient.writeContract({
      address: voucherRegistry,
      abi: REGISTRY_ABI,
      functionName: "register",
      args: [voucheeLabel, DEPLOYER_ADDRESS, voucheeRegistry, AVAL_ETH_RESOLVER, SOULBOUND_ROLES, expiry],
    });
    const receipt = await publicClient.waitForTransactionReceipt({ hash: registerTxHash });
    if (receipt.status !== "success") throw new Error(`register("${name}") reverted: ${registerTxHash}`);
  } else {
    const current = await getSubregistry(publicClient, voucherRegistry, voucheeLabel);
    if (current.toLowerCase() !== voucheeRegistry.toLowerCase()) {
      const tokenId = await publicClient.readContract({
        address: voucherRegistry,
        abi: REGISTRY_ABI,
        functionName: "findTokenId",
        args: [voucheeLabel],
      });
      setSubregistryTxHash = await walletClient.writeContract({
        address: voucherRegistry,
        abi: REGISTRY_ABI,
        functionName: "setSubregistry",
        args: [tokenId, voucheeRegistry],
      });
      const receipt = await publicClient.waitForTransactionReceipt({ hash: setSubregistryTxHash });
      if (receipt.status !== "success") throw new Error(`setSubregistry("${name}") reverted: ${setSubregistryTxHash}`);
    }
  }

  const setAddrTxHash = await setAddrIfNeeded(clients, name, voucheeAddress, name, registerTxHash);

  // A vouch holding ROLE_CAN_TRANSFER_ADMIN on its own token resource is not reached by the root
  // revocation above. Retro-fit in place (no-op for fresh mints).
  const retroTxHash = await makeExistingNameSoulbound(clients, voucherRegistry, voucheeLabel);

  const resolvedAddress = await readAddrRecord(publicClient, name);
  const wired = await getSubregistry(publicClient, voucherRegistry, voucheeLabel);
  await assertWired(publicClient, name, wired, resolvedAddress, voucheeAddress);
  await assertSoulbound(publicClient, voucherRegistry, voucheeLabel, name);

  return {
    name,
    voucherLabel,
    voucheeLabel,
    voucherRegistry,
    voucheeRegistry: wired,
    voucheeRegistryDeployTxHash: vouchee.deployTxHash,
    voucheeRegistryAttachTxHash: vouchee.attachTxHash,
    registerTxHash,
    setAddrTxHash,
    setSubregistryTxHash,
    resolvedAddress,
    soulboundTxHashes: [voucherRegistrySoulboundTx, vouchee.soulboundTxHash, retroTxHash].filter(
      (h): h is Hex => h !== null,
    ),
    alreadyComplete: registerTxHash === null && setAddrTxHash === null && setSubregistryTxHash === null,
  };
}

// ── shared internals ──────────────────────────────────────────────────────────────────────────

/** Deploys and attaches the vouchee's depth-1 registry if they somehow don't have one yet. */
async function mintOrEnsureVoucheeRegistry(clients: EnsClients, voucheeLabel: string): Promise<DeployedRegistry> {
  const { publicClient, walletClient } = clients;
  const existing = await getSubregistry(publicClient, AVAL_ETH_REGISTRY, voucheeLabel);
  if (await hasContractCode(publicClient, existing)) {
    return {
      address: existing,
      salt: memberRegistrySalt(voucheeLabel),
      deployTxHash: null,
      attachTxHash: null,
      soulboundTxHash: await ensureRegistrySoulbound(clients, existing),
    };
  }
  const deployed = await deployMemberRegistry(clients, voucheeLabel);
  const tokenId = await publicClient.readContract({
    address: AVAL_ETH_REGISTRY,
    abi: REGISTRY_ABI,
    functionName: "findTokenId",
    args: [voucheeLabel],
  });
  const hash = await walletClient.writeContract({
    address: AVAL_ETH_REGISTRY,
    abi: REGISTRY_ABI,
    functionName: "setSubregistry",
    args: [tokenId, deployed.address],
  });
  const receipt = await publicClient.waitForTransactionReceipt({ hash });
  if (receipt.status !== "success") throw new Error(`setSubregistry("${voucheeLabel}") reverted: ${hash}`);
  return { ...deployed, attachTxHash: hash };
}

async function setAddrIfNeeded(
  clients: EnsClients,
  name: string,
  targetAddress: Address,
  errorLabel: string,
  registerTxHash: Hex | null,
): Promise<Hex | null> {
  const { publicClient, walletClient } = clients;
  const current = await readAddrRecord(publicClient, name);
  if (current && current.toLowerCase() === targetAddress.toLowerCase()) return null;

  const hash = await walletClient.writeContract({
    address: AVAL_ETH_RESOLVER,
    abi: RESOLVER_ABI,
    functionName: "setAddr",
    args: [namehash(name), targetAddress],
  });
  const receipt = await publicClient.waitForTransactionReceipt({ hash });
  if (receipt.status !== "success") throw new EnsMintPartialError(errorLabel, registerTxHash, hash);
  return hash;
}

/** The read-back gate. A receipt that did not revert is not evidence; these three reads are. */
async function assertWired(
  client: EnsPublicClient,
  name: string,
  subregistry: Address,
  resolvedAddress: Address | null,
  targetAddress: Address,
): Promise<void> {
  if (!resolvedAddress || resolvedAddress.toLowerCase() !== targetAddress.toLowerCase()) {
    throw new Error(`"${name}" resolves to ${resolvedAddress ?? "nothing"} after setAddr, expected ${targetAddress}.`);
  }
  if (subregistry === ZERO_ADDRESS) {
    throw new Error(`"${name}" has no subregistry after provisioning — nested names would be impossible.`);
  }
  if (!(await hasContractCode(client, subregistry))) {
    throw new Error(`"${name}" points at subregistry ${subregistry}, but there is no contract code there.`);
  }
}
