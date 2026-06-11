import { ContractDeployer } from "dedot/contracts";

import {
  bigintReplacer,
  connect,
  findRootContractAddress,
  generateSalt,
  getCliFlag,
  loadArtifact,
  loadEnv,
  loadSigner,
  logStatus,
  requireValue,
} from "./common.js";

interface DeploymentResult {
  events: unknown[];
  contractAddress(): Promise<string>;
}

async function main(): Promise<void> {
  const { deployerSuri, wsEndpoint } = loadEnv();

  const tokenAddress = requireValue(
    getCliFlag("--token") ?? process.env.TOKEN_ADDRESS,
    "--token / TOKEN_ADDRESS (tUSDT ERC-20 contract address)",
  );

  console.log(`🔌 Connecting to ${wsEndpoint}`);
  const client = await connect(wsEndpoint);

  try {
    const signer = await loadSigner(deployerSuri);
    console.log(`👤 Deployer: ${signer.address}`);

    const artifact = loadArtifact("tusdt_treasury");
    const deployer = new ContractDeployer(
      client,
      artifact.metadata,
      artifact.wasmHex,
    );

    const salt = generateSalt();
    console.log("🧪 Dry-running treasury.new(...)");
    const dryRun = await (deployer.query as unknown as {
      new: (
        ...args: unknown[]
      ) => Promise<{
        raw: { gasRequired: unknown; storageDeposit: unknown };
      }>;
    }).new(tokenAddress, { caller: signer.address, salt });
    console.log(
      `  ↳ gasRequired=${JSON.stringify(dryRun.raw.gasRequired, bigintReplacer)} storageDeposit=${JSON.stringify(dryRun.raw.storageDeposit, bigintReplacer)}`,
    );

    console.log("🚀 Submitting treasury deployment");
    const tx = (deployer.tx as unknown as {
      new: (...args: unknown[]) => {
        signAndSend: (
          signer: unknown,
          cb: (r: { status: { type: string } }) => void,
        ) => { untilFinalized(): Promise<DeploymentResult> };
      };
    }).new(tokenAddress, { salt });

    const result = await tx
      .signAndSend(signer, logStatus("treasury"))
      .untilFinalized();

    const reportedAddress = await result.contractAddress();
    const treasuryAddress =
      findRootContractAddress(client, result.events, signer.address) ??
      reportedAddress;
    if (treasuryAddress !== reportedAddress) {
      console.log(
        `ℹ️  dedot reported ${reportedAddress}; using ${treasuryAddress} (deployed by signer) as treasury.`,
      );
    }

    console.log("\n✅ Treasury deployed");
    console.log(
      JSON.stringify(
        {
          treasury: treasuryAddress,
          token: tokenAddress,
          deployer: signer.address,
        },
        null,
        2,
      ),
    );
  } finally {
    await client.disconnect();
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
