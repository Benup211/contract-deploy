import { Contract } from "dedot/contracts";

import {
  bigintReplacer,
  connect,
  getCliFlag,
  loadArtifact,
  loadEnv,
  loadSigner,
  requireValue,
} from "./common.js";

function extractData(result: any) {
  return (
    result?.data ??
    result?.value ??
    result?.result?.value ??
    result?.result?.ok?.value ??
    result
  );
}

async function main(): Promise<void> {
  const { deployerSuri, wsEndpoint } = loadEnv();

  const vaultAddress = requireValue(
    getCliFlag("--vault") ?? process.env.VAULT_ADDRESS,
    "--vault / VAULT_ADDRESS",
  );

  console.log(`🔌 Connecting to ${wsEndpoint}`);
  const client = await connect(wsEndpoint);

  try {
    const signer = await loadSigner(deployerSuri);
    const artifact = loadArtifact("tusdt_vault");

    const contract = new Contract<any>(
      client,
      artifact.metadata,
      vaultAddress,
      { defaultCaller: signer.address },
    );

    const getters = [
      "governance",
      "treasury",
      "paused",
      "getTokenAddress",
      "getAuctionAddress",
      "getOracleAddress",
    ];

    for (const name of getters) {
      try {
        const fn = (contract.query as any)[name];

        if (typeof fn !== "function") {
          console.log(`⚠️ ${name}: not found in metadata`);
          continue;
        }

        // ✅ FIX: ONLY ONE ARGUMENT OBJECT
        const result = await fn({
          caller: signer.address,
        });

        const data = extractData(result);

        console.log(
          `${name}:`,
          JSON.stringify(data),
        );
      } catch (err) {
        console.log(
          `${name}: ERROR ${(err as Error).message?.slice(0, 200)}`,
        );
      }
    }
  } finally {
    await client.disconnect();
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});