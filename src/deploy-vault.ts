import { ContractDeployer } from "dedot/contracts";

import {
  bigintReplacer,
  connect,
  findChildInstantiations,
  findRootContractAddress,
  generateSalt,
  getCliFlag,
  loadArtifact,
  loadEnv,
  loadSigner,
  logStatus,
  requireValue,
  uploadCode,
} from "./common.js";

interface DeploymentResult {
  events: unknown[];
  contractAddress(): Promise<string>;
}

async function main(): Promise<void> {
  const { deployerSuri, wsEndpoint } = loadEnv();

  const treasury = requireValue(
    getCliFlag("--treasury") ?? process.env.TREASURY_ADDRESS,
    "--treasury / TREASURY_ADDRESS (treasury AccountId for vault)",
  );

  console.log(`🔌 Connecting to ${wsEndpoint}`);
  const client = await connect(wsEndpoint);

  try {
    const signer = await loadSigner(deployerSuri);
    console.log(`👤 Deployer: ${signer.address}`);

    // 1. Upload child wasm blobs to obtain their code hashes.
    const tokenArtifact = loadArtifact("tusdt_erc20");
    const auctionArtifact = loadArtifact("tusdt_auction");
    const oracleArtifact = loadArtifact("tusdt_oracle");

    const tokenCodeHash = await uploadCode(
      client,
      signer,
      tokenArtifact.wasmHex,
      "tusdt_erc20",
    );
    const auctionCodeHash = await uploadCode(
      client,
      signer,
      auctionArtifact.wasmHex,
      "tusdt_auction",
    );
    const oracleCodeHash = await uploadCode(
      client,
      signer,
      oracleArtifact.wasmHex,
      "tusdt_oracle",
    );

    // 2. Deploy the vault. The vault constructor internally instantiates the
    //    erc20/auction/oracle child contracts using the supplied code hashes.
    const vaultArtifact = loadArtifact("tusdt_vault");
    const deployer = new ContractDeployer(
      client,
      vaultArtifact.metadata,
      vaultArtifact.wasmHex,
    );

    const salt = generateSalt();
    const constructorArgs = [
      treasury,
      tokenCodeHash,
      auctionCodeHash,
      oracleCodeHash,
    ] as const;

    console.log("🧪 Dry-running vault.new(...)");
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

    console.log("🚀 Submitting vault deployment");
    const tx = (deployer.tx as unknown as {
      new: (...args: unknown[]) => {
        signAndSend: (
          signer: unknown,
          cb: (r: { status: { type: string } }) => void,
        ) => { untilFinalized(): Promise<DeploymentResult> };
      };
    }).new(...constructorArgs, { salt });

    const result = await tx
      .signAndSend(signer, logStatus("vault"))
      .untilFinalized();

    const reportedAddress = await result.contractAddress();
    // Cross-contract instantiation: child Instantiated events fire BEFORE the
    // vault's own Instantiated event. dedot's `contractAddress()` returns the
    // first event's contract, which is a child — not the vault. The real vault
    // is the Instantiated event whose deployer is the human signer.
    const vaultAddress =
      findRootContractAddress(client, result.events, signer.address) ??
      reportedAddress;
    if (vaultAddress !== reportedAddress) {
      console.log(
        `ℹ️  dedot reported ${reportedAddress}; using ${vaultAddress} (deployed by signer) as vault.`,
      );
    }
    const children = findChildInstantiations(client, result.events, vaultAddress);
    // Source order in tusdt-vault: token, auction, oracle (salts [0;32], [1;32], [2;32]).
    const [tokenAddr, auctionAddr, oracleAddr] = children.map(
      (c) => c.contractAddress,
    );

    console.log("\n✅ Vault deployed");
    console.log(
      JSON.stringify(
        {
          vault: vaultAddress,
          token: tokenAddr,
          auction: auctionAddr,
          oracle: oracleAddr,
          treasury,
          deployer: signer.address,
          codeHashes: {
            token: tokenCodeHash,
            auction: auctionCodeHash,
            oracle: oracleCodeHash,
          },
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
