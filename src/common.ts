import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import "dotenv/config";

import { DedotClient, WsProvider } from "dedot";
import { u8aToHex, hexToU8a } from "dedot/utils";
import { Keyring } from "@polkadot/keyring";
import { cryptoWaitReady } from "@polkadot/util-crypto";
import type { KeyringPair } from "@polkadot/keyring/types";

const __dirname = dirname(fileURLToPath(import.meta.url));
const BUILD_DIR = resolve(__dirname, "..", "contract_build");

export const DEFAULT_WS_ENDPOINT = "wss://test.finney.opentensor.ai:443";

export interface EnvConfig {
  deployerSuri: string;
  wsEndpoint: string;
}

export function loadEnv(): EnvConfig {
  const deployerSuri = process.env.DEPLOYER;
  if (!deployerSuri) {
    throw new Error(
      "DEPLOYER is required. Set it in contract-deploy/.env (see .env.example).",
    );
  }
  return {
    deployerSuri,
    wsEndpoint: process.env.WS_ENDPOINT ?? DEFAULT_WS_ENDPOINT,
  };
}

export async function connect(wsEndpoint: string): Promise<DedotClient> {
  const provider = new WsProvider(wsEndpoint);
  return await DedotClient.new(provider);
}

export async function loadSigner(suri: string): Promise<KeyringPair> {
  await cryptoWaitReady();
  const keyring = new Keyring({ type: "sr25519" });
  return keyring.addFromUri(suri);
}

// `any` here so the metadata satisfies dedot's `LooseContractMetadata`
// (a structural type that demands index signatures we can't easily mirror).
// The runtime is what matters — typecheck-wise we trust the JSON shape.
export interface ContractArtifact {
  name: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  metadata: any;
  wasmHex: `0x${string}`;
}

export function loadArtifact(name: string): ContractArtifact {
  const jsonPath = resolve(BUILD_DIR, `${name}.json`);
  const wasmPath = resolve(BUILD_DIR, `${name}.wasm`);
  const metadata = JSON.parse(readFileSync(jsonPath, "utf8"));
  const wasm = readFileSync(wasmPath);
  const wasmHex = u8aToHex(new Uint8Array(wasm)) as `0x${string}`;
  return { name, metadata, wasmHex };
}

export function getCliFlag(name: string): string | undefined {
  const args = process.argv.slice(2);
  const index = args.indexOf(name);
  return index === -1 ? undefined : args[index + 1];
}

export function requireValue(value: string | undefined, label: string): string {
  if (!value) {
    throw new Error(`Missing ${label}. Pass it as a CLI flag or env var.`);
  }
  return value;
}

export function generateSalt(): `0x${string}` {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return u8aToHex(bytes) as `0x${string}`;
}

/**
 * Upload a wasm blob via `pallet-contracts::upload_code` and return the resulting code hash.
 * Handles both 2-arg (older) and 3-arg (with Determinism::Enforced) variants of the extrinsic.
 * If the wasm is already on-chain, returns the deterministic blake2-256 hash of the wasm.
 */
export async function uploadCode(
  client: DedotClient,
  signer: KeyringPair,
  wasmHex: `0x${string}`,
  label: string,
): Promise<`0x${string}`> {
  const contractsTx = (client.tx as unknown as Record<string, unknown>)
    .contracts as
    | {
        uploadCode: ((...args: unknown[]) => unknown) & {
          meta?: { fields?: unknown[]; args?: unknown[] };
        };
      }
    | undefined;

  if (!contractsTx?.uploadCode) {
    throw new Error(
      "The connected runtime does not expose `contracts.uploadCode`. " +
        "Check that the target chain runs pallet-contracts.",
    );
  }

  const meta = contractsTx.uploadCode.meta;
  const argCount = meta?.fields?.length ?? meta?.args?.length ?? 0;
  // For ink! v5 / cargo-contract 5.x, wasm is compiled with deterministic instrumentation;
  // pass `Determinism::Enforced` when the extrinsic takes 3 args.
  // Dedot expects `undefined` (not `null`) for `Option<storage_deposit_limit>` and the
  // bare string `'Enforced'` for the `Determinism` enum (it's a `literalUnion` codec).
  const tx =
    argCount >= 3
      ? (contractsTx.uploadCode(
          wasmHex,
          undefined,
          "Enforced",
        ) as ReturnType<typeof signedTxStub>)
      : (contractsTx.uploadCode(wasmHex, undefined) as ReturnType<
          typeof signedTxStub
        >);

  console.log(`📦 Uploading wasm: ${label} (${wasmHex.length / 2 - 1} bytes)`);
  try {
    const result = await tx
      .signAndSend(signer, ({ status }: { status: { type: string } }) => {
        if (status.type === "BestChainBlockIncluded" || status.type === "Finalized") {
          console.log(`  ↳ ${label}: ${status.type}`);
        }
      })
      .untilFinalized();

    const storedEvent = client.events.contracts.CodeStored.find(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      result.events as any,
    );
    if (storedEvent) {
      const codeHash = (storedEvent as unknown as {
        palletEvent: { data: { codeHash: { toString(): string } } };
      }).palletEvent.data.codeHash.toString();
      console.log(`  ↳ ${label} codeHash: ${codeHash}`);
      return codeHash as `0x${string}`;
    }
    if (result.dispatchError) {
      throw new Error(
        `Upload of ${label} failed: ${JSON.stringify(result.dispatchError)}`,
      );
    }
    // No CodeStored event and no error → wasm was already on-chain (upload_code is
    // idempotent and silent in that case). Derive the code hash locally.
    const { blake2AsHex } = await import("@polkadot/util-crypto");
    const codeHash = blake2AsHex(hexToU8a(wasmHex), 256) as `0x${string}`;
    console.log(
      `  ↳ ${label} already on-chain (no CodeStored event), codeHash: ${codeHash}`,
    );
    return codeHash;
  } catch (err) {
    // If already uploaded (DuplicateContract / CodeAlreadyExists), compute the hash locally.
    const msg = String(err);
    if (/DuplicateContract|CodeAlreadyExists|already.*stored/i.test(msg)) {
      const { blake2AsHex } = await import("@polkadot/util-crypto");
      const codeHash = blake2AsHex(hexToU8a(wasmHex), 256) as `0x${string}`;
      console.log(`  ↳ ${label} already on-chain, computed codeHash: ${codeHash}`);
      return codeHash;
    }
    throw err;
  }
}

declare function signedTxStub(): {
  signAndSend(
    signer: KeyringPair,
    cb: (r: { status: { type: string } }) => void,
  ): {
    untilFinalized(): Promise<{
      events: unknown[];
      dispatchError?: unknown;
    }>;
  };
};

export interface InstantiatedChild {
  contractAddress: string;
  deployerAddress: string;
}

/** Normalize whatever shape dedot gives us for an AccountId into a raw hex string. */
function accountIdToRawHex(value: unknown): string {
  if (value == null) return "";
  if (typeof value === "string") {
    if (value.startsWith("0x")) return value.toLowerCase();
    // SS58 string → decode to raw bytes
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { decodeAddress } = require("@polkadot/util-crypto") as {
        decodeAddress: (s: string) => Uint8Array;
      };
      return u8aToHex(decodeAddress(value)).toLowerCase();
    } catch {
      return value.toLowerCase();
    }
  }
  // dedot AccountId32 instances expose .raw (Uint8Array) and .address() (SS58)
  const obj = value as {
    raw?: Uint8Array;
    address?: () => string;
    toString?: () => string;
  };
  if (obj.raw instanceof Uint8Array) return u8aToHex(obj.raw).toLowerCase();
  if (typeof obj.address === "function") {
    try {
      return accountIdToRawHex(obj.address());
    } catch {
      /* fall through */
    }
  }
  if (typeof obj.toString === "function") {
    return accountIdToRawHex(obj.toString());
  }
  return "";
}

/**
 * Find the Instantiated event in a deployment result whose deployer matches the
 * given address (typically the human signer). Use this instead of dedot's
 * `result.contractAddress()` when the constructor itself spawns child contracts:
 * dedot returns the first Instantiated event, but with cross-contract instantiation
 * the children fire first and the parent fires last.
 */
export function findRootContractAddress(
  client: DedotClient,
  events: unknown[],
  deployerAddress: string,
): string | undefined {
  const all = client.events.contracts.Instantiated.filter(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    events as any,
  ) as Array<{
    palletEvent: { data: { deployer: unknown; contract: unknown } };
  }>;
  const deployerRaw = accountIdToRawHex(deployerAddress);
  for (const e of all) {
    if (accountIdToRawHex(e.palletEvent.data.deployer) !== deployerRaw) continue;
    const c = e.palletEvent.data.contract as {
      address?: () => string;
      toString?: () => string;
    };
    return typeof c.address === "function" ? c.address() : String(c);
  }
  return undefined;
}

/**
 * Scan a finalized deployment result for every Contracts.Instantiated event
 * whose deployer matches the supplied address (e.g. the vault's address for
 * cross-contract child instantiations). Returns them in event-order.
 */
export function findChildInstantiations(
  client: DedotClient,
  events: unknown[],
  parentAddress: string,
): InstantiatedChild[] {
  const all = client.events.contracts.Instantiated.filter(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    events as any,
  ) as Array<{
    palletEvent: { data: { deployer: unknown; contract: unknown } };
  }>;

  const parentRaw = accountIdToRawHex(parentAddress);
  console.log(
    `🔎 Instantiated events: ${all.length}, parent=${parentRaw.slice(0, 18)}…`,
  );
  for (const e of all) {
    const dRaw = accountIdToRawHex(e.palletEvent.data.deployer);
    const cRaw = accountIdToRawHex(e.palletEvent.data.contract);
    console.log(
      `  · deployer=${dRaw.slice(0, 18)}… contract=${cRaw.slice(0, 18)}…`,
    );
  }

  const children: InstantiatedChild[] = [];
  for (const e of all) {
    const deployerRaw = accountIdToRawHex(e.palletEvent.data.deployer);
    if (deployerRaw !== parentRaw) continue;
    const contractField = e.palletEvent.data.contract as {
      address?: () => string;
      toString?: () => string;
    };
    const contractAddress =
      typeof contractField.address === "function"
        ? contractField.address()
        : String(contractField);
    children.push({ contractAddress, deployerAddress: parentAddress });
  }
  return children;
}

export function logStatus(label: string) {
  return ({ status }: { status: { type: string } }) => {
    console.log(`📊 ${label} status: ${status.type}`);
  };
}

/** JSON.stringify replacer that turns BigInts into their decimal string. */
export function bigintReplacer(_key: string, value: unknown): unknown {
  return typeof value === "bigint" ? value.toString() : value;
}
