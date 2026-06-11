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

  const treasury = requireValue(
    getCliFlag("--treasury") ?? process.env.TREASURY_ADDRESS,
    "--treasury / TREASURY_ADDRESS",
  );
  const vault = requireValue(
    getCliFlag("--vault") ?? process.env.VAULT_ADDRESS,
    "--vault / VAULT_ADDRESS",
  );
  const auction = requireValue(
    getCliFlag("--auction") ?? process.env.AUCTION_ADDRESS,
    "--auction / AUCTION_ADDRESS",
  );
  const oracle = requireValue(
    getCliFlag("--oracle") ?? process.env.ORACLE_ADDRESS,
    "--oracle / ORACLE_ADDRESS",
  );
  const maintainer = requireValue(
    getCliFlag("--maintainer") ?? process.env.MAINTAINER_ADDRESS,
    "--maintainer / MAINTAINER_ADDRESS",
  );

  console.log(`🔌 Connecting to ${wsEndpoint}`);
  const client = await connect(wsEndpoint);

  try {
    const signer = await loadSigner(deployerSuri);
    console.log(`👤 Deployer: ${signer.address}`);

    const artifact = loadArtifact("tusdt_governance");
    const deployer = new ContractDeployer(
      client,
      artifact.metadata,
      artifact.wasmHex,
    );

    const salt = generateSalt();
    const constructorArgs = [treasury, vault, auction, oracle, maintainer] as const;

    console.log("🧪 Dry-running governance.new(...)");
    const dryRun = await (deployer.query as unknown as {
      new: (
        ...args: unknown[]
      ) => Promise<{
        raw: { gasRequired: unknown; storageDeposit: unknown };
      }>;
    }).new(...constructorArgs, { caller: signer.address, salt });
    console.log(
      `  ↳ gasRequired=${JSON.stringify(dryRun.raw.gasRequired, bigintReplacer)} storageDeposit=${JSON.stringify(dryRun.raw.storageDeposit, bigintReplacer)}`,
    );

    console.log("🚀 Submitting governance deployment");
    const tx = (deployer.tx as unknown as {
      new: (...args: unknown[]) => {
        signAndSend: (
          signer: unknown,
          cb: (r: { status: { type: string } }) => void,
        ) => { untilFinalized(): Promise<DeploymentResult> };
      };
    }).new(...constructorArgs, { salt });

    const result = await tx
      .signAndSend(signer, logStatus("governance"))
      .untilFinalized();

    const reportedAddress = await result.contractAddress();
    const governanceAddress =
      findRootContractAddress(client, result.events, signer.address) ??
      reportedAddress;
    if (governanceAddress !== reportedAddress) {
      console.log(
        `ℹ️  dedot reported ${reportedAddress}; using ${governanceAddress} (deployed by signer) as governance.`,
      );
    }

    console.log("\n✅ Governance deployed");
    console.log(
      JSON.stringify(
        {
          governance: governanceAddress,
          treasury,
          vault,
          auction,
          oracle,
          maintainer,
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
