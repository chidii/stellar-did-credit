import {
  Contract,
  SorobanRpc,
  TransactionBuilder,
  BASE_FEE,
  Account,
  scValToNative,
  nativeToScVal,
  Address,
  xdr,
  Keypair,
} from "@stellar/stellar-sdk";
import { assembleTransaction } from "@stellar/stellar-sdk/rpc";

export const MIN_SCORE = 300;
export const MAX_SCORE = 850;

export type NetworkType = 'testnet' | 'mainnet' | 'futurenet' | 'custom';

export interface ScoreRecord {
  score: number;
  lastUpdated: number;
  vcCount: number;
  repaymentRate: number;
  txVolume30d: bigint;
  previousScore: number | null;
  /** Ledger sequence number when this score was last computed. */
  computedAtLedger: number;
  /** Whether the score is considered stale. */
  stale: boolean;
}

export interface TxStats {
  volume30d: bigint;
  txCount30d: number;
  avgCounterparties: number;
}

export interface ScoringWeights {
  vcWeight: number;
  txWeight: number;
  repaymentWeight: number;
}

export interface RepaymentRecord {
  onTimeCount: number;
  totalCount: number;
  totalRepaid: bigint;
}

export interface VCRecord {
  vcHash: Buffer;
  issuer: string;
  anchoredAt: number;
  revoked: boolean;
}

export interface GovernanceProposal {
  id: bigint;
  proposer: string;
  proposedWeights: ScoringWeights;
  votesFor: bigint;
  votesAgainst: bigint;
  expiryLedger: number;
  executionDelayLedgers: number;
  executed: boolean;
  cancelled: boolean;
  quorumRequired: bigint;
}

export interface ProtocolConfig {
  identityOracleId: string;
  creditOracleId: string;
  revocationRegistryId: string;
  governanceId?: string;
  networkPassphrase: string;
  rpcUrl: string;
  simAccount: string;
  timeoutSeconds?: number;
  maxRetries?: number;
  baseFee?: string;
  confirmationTimeoutMs?: number;
  pollIntervalMs?: number;
  network?: NetworkType;
}

export type Unsubscribe = () => void;

export type SDKErrorCode =
  | "INVALID_VC_HASH"
  | "MISSING_REVOCATION_REGISTRY"
  | "NOT_REGISTERED_ISSUER"
  | "TRANSACTION_FAILED"
  | "TRANSACTION_TIMEOUT"
  | "COOLDOWN_ACTIVE";

// ---------------------------------------------------------------------------
// Contract error hierarchy
// ---------------------------------------------------------------------------

/** Base class for typed errors returned by Soroban smart contracts. */
export class ContractError extends Error {
  constructor(
    public readonly code: number,
    public readonly contractName: string,
    message: string,
  ) {
    super(message);
    this.name = "ContractError";
  }
}

export class IdentityOracleError extends ContractError {
  constructor(code: number, message: string) {
    super(code, "identity-oracle", message);
    this.name = "IdentityOracleError";
  }
}

export class CreditOracleError extends ContractError {
  constructor(code: number, message: string) {
    super(code, "credit-oracle", message);
    this.name = "CreditOracleError";
  }
}

export class RevocationRegistryError extends ContractError {
  constructor(code: number, message: string) {
    super(code, "revocation-registry", message);
    this.name = "RevocationRegistryError";
  }
}

export class GovernanceError extends ContractError {
  constructor(code: number, message: string) {
    super(code, "governance", message);
    this.name = "GovernanceError";
  }
}

// ---------------------------------------------------------------------------
// Error code maps
// ---------------------------------------------------------------------------

const IDENTITY_ORACLE_ERROR_CODES: Record<number, string> = {
  1: "AlreadyInitialized",
  2: "NotAuthorized",
  3: "IssuerNotRegistered",
  4: "InvalidCID",
  5: "NoPendingAdmin",
  6: "DuplicateVC",
  7: "VCNotFound",
  8: "ContractPaused",
  9: "InvalidRevocationRegistry",
  10: "VCLimitReached",
};

const CREDIT_ORACLE_ERROR_CODES: Record<number, string> = {
  1: "AlreadyInitialized",
  2: "NotAuthorized",
  3: "FeederNotRegistered",
  4: "LenderNotRegistered",
  5: "InvalidWeights",
  6: "NoPendingAdmin",
  7: "ComputeCooldownActive",
  8: "DisputeAlreadyPending",
  9: "DisputeNotFound",
  10: "InvalidInputKey",
  11: "InvalidIdentityOracle",
  12: "ContractPaused",
  13: "InvalidRecencyConfig",
  14: "TimelockNotExpired",
  15: "NoPendingWeights",
  16: "NotInitialized",
};

const REVOCATION_REGISTRY_ERROR_CODES: Record<number, string> = {
  1: "AlreadyInitialized",
  2: "NotAuthorized",
  3: "IssuerMismatch",
  4: "NoPendingAdmin",
  5: "BatchTooLarge",
  6: "ContractPaused",
  7: "ReentrancyDetected",
  8: "InvalidBatchLimit",
};

const GOVERNANCE_ERROR_CODES: Record<number, string> = {
  1: "AlreadyInitialized",
  2: "NotAuthorized",
  3: "ProposalNotFound",
  4: "ProposalExpired",
  5: "ProposalNotExpired",
  6: "ProposalAlreadyExecuted",
  7: "InvalidWeights",
  8: "InvalidQuorum",
  9: "InvalidVoteWeight",
  10: "QuorumNotMet",
  11: "TimelockNotExpired",
  12: "VoterNotRegistered",
  13: "InsufficientVoteWeight",
  14: "ProposalAlreadyCancelled",
};

const ERROR_CODE_MAPS: Record<string, Record<number, string>> = {
  "identity-oracle": IDENTITY_ORACLE_ERROR_CODES,
  "credit-oracle": CREDIT_ORACLE_ERROR_CODES,
  "revocation-registry": REVOCATION_REGISTRY_ERROR_CODES,
  governance: GOVERNANCE_ERROR_CODES,
};

// ---------------------------------------------------------------------------
// Contract error parsing
// ---------------------------------------------------------------------------

const CONTRACT_ERROR_RE = /Error\(Contract,\s*#(\d+)\)/i;

export function parseContractErrorCode(errorString: string): number | null {
  const match = CONTRACT_ERROR_RE.exec(errorString);
  return match ? Number(match[1]) : null;
}

export function throwContractError(
  errorString: string,
  contractName:
    | "identity-oracle"
    | "credit-oracle"
    | "revocation-registry"
    | "governance",
): never {
  const code = parseContractErrorCode(errorString);
  const codeMap = ERROR_CODE_MAPS[contractName];
  const variantName = code !== null && codeMap ? codeMap[code] : undefined;
  const message =
    code !== null && variantName
      ? `${variantName} (code ${code})`
      : errorString;

  switch (contractName) {
    case "identity-oracle":
      throw new IdentityOracleError(code ?? 0, message);
    case "credit-oracle":
      throw new CreditOracleError(code ?? 0, message);
    case "revocation-registry":
      throw new RevocationRegistryError(code ?? 0, message);
    case "governance":
      throw new GovernanceError(code ?? 0, message);
  }
}

export class SDKError extends Error {
  constructor(
    public readonly code: SDKErrorCode,
    message: string,
    options?: {
      cause?: unknown;
      transactionHash?: string;
      resultXdr?: string;
    },
  ) {
    super(message);
    if (options?.cause !== undefined) {
      this.cause = options.cause;
    }
    this.transactionHash = options?.transactionHash;
    this.resultXdr = options?.resultXdr;
    this.name = "SDKError";
  }

  declare readonly cause?: unknown;
  declare readonly transactionHash?: string;
  declare readonly resultXdr?: string;
}

export interface BatchChunkResult {
  chunkIndex: number;
  vcHashes: Buffer[];
  status: "fulfilled" | "rejected";
  transactionHash?: string;
  error?: SDKError;
}

export interface BatchResult {
  success: boolean;
  failedChunks: number;
  transactionHashes: string[];
  chunks: BatchChunkResult[];
}

const NETWORK_CONFIGS: Record<Exclude<NetworkType, 'custom'>, Partial<ProtocolConfig>> = {
  testnet: {
    networkPassphrase: "Test SDF Network ; September 2015",
    rpcUrl: "https://soroban-testnet.stellar.org",
    simAccount: "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF",
  },
  mainnet: {
    networkPassphrase: "Public Global Stellar Network ; September 2015",
    rpcUrl: "https://soroban-rpc.mainnet.stellarchain.io",
    simAccount: "",
  },
  futurenet: {
    networkPassphrase: "Test SDF Future Network ; October 2022",
    rpcUrl: "https://rpc-futurenet.stellar.org",
    simAccount: "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF",
  },
};

export type KeypairLike = Keypair | { publicKey: string };

export function createNetworkConfig(
  network: NetworkType,
  overrides: Partial<ProtocolConfig> = {}
): Partial<ProtocolConfig> {
  if (network === 'custom') {
    return overrides;
  }
  
  const networkDefaults = NETWORK_CONFIGS[network];
  return {
    ...networkDefaults,
    ...overrides,
  };
}

export type GovernanceInteger = number | bigint;

export class GovernanceClient {
  private readonly server: SorobanRpc.Server;

  constructor(
    private readonly config: ProtocolConfig,
    server?: SorobanRpc.Server,
  ) {
    this.server = server ?? new SorobanRpc.Server(config.rpcUrl);
  }

  async createProposal(
    proposerKeypair: Keypair,
    weights: ScoringWeights,
    votingPeriodLedgers: number,
    executionDelayLedgers: number,
  ): Promise<bigint> {
    const proposer = getPublicKey(proposerKeypair);
    const contract = this.governanceContract();
    const result = await this.submitSignedTransaction(
      proposerKeypair,
      contract.call(
        "create_proposal",
        new Address(proposer).toScVal(),
        scoringWeightsToScVal(weights),
        nativeToScVal(votingPeriodLedgers, { type: "u32" }),
        nativeToScVal(executionDelayLedgers, { type: "u32" }),
      ),
      "createProposal",
    );

    if (!result.retval) {
      throw new Error("createProposal returned no proposal ID");
    }
    return BigInt(scValToNative(result.retval) as bigint | number | string);
  }

  async vote(
    voterKeypair: Keypair,
    proposalId: GovernanceInteger,
    voteFor: boolean,
    voteWeight: GovernanceInteger,
  ): Promise<string> {
    const voter = getPublicKey(voterKeypair);
    const contract = this.governanceContract();
    return (
      await this.submitSignedTransaction(
        voterKeypair,
        contract.call(
          "vote",
          new Address(voter).toScVal(),
          nativeToScVal(toUnsignedBigInt(proposalId), { type: "u64" }),
          nativeToScVal(voteFor),
          nativeToScVal(toPositiveBigInt(voteWeight), { type: "i128" }),
        ),
        "vote",
      )
    ).hash;
  }

  async execute(
    payerKeypair: Keypair,
    proposalId: GovernanceInteger,
  ): Promise<string> {
    const contract = this.governanceContract();
    return (
      await this.submitSignedTransaction(
        payerKeypair,
        contract.call(
          "execute",
          nativeToScVal(toUnsignedBigInt(proposalId), { type: "u64" }),
        ),
        "execute",
      )
    ).hash;
  }

  async applyWeights(payerKeypair: Keypair): Promise<string> {
    const contract = this.governanceContract();
    return (
      await this.submitSignedTransaction(
        payerKeypair,
        contract.call("apply_weights"),
        "applyWeights",
      )
    ).hash;
  }

  async getProposal(
    proposalId: GovernanceInteger,
  ): Promise<GovernanceProposal | null> {
    const contract = this.governanceContract();
    const retval = await this.simulateRead(
      contract.call(
        "get_proposal",
        nativeToScVal(toUnsignedBigInt(proposalId), { type: "u64" }),
      ),
    );
    const native = scValToNative(retval);
    return native === null || native === undefined
      ? null
      : parseGovernanceProposal(native);
  }

  async listProposals(
    fromId: GovernanceInteger,
    limit: number,
  ): Promise<GovernanceProposal[]> {
    if (!Number.isInteger(limit) || limit < 0) {
      throw new Error("limit must be a non-negative integer");
    }

    const firstId = toUnsignedBigInt(fromId);
    const proposals: GovernanceProposal[] = [];
    for (let offset = 0n; offset < BigInt(limit); offset += 1n) {
      const proposal = await this.getProposal(firstId + offset);
      if (proposal) {
        proposals.push(proposal);
      }
    }
    return proposals;
  }

  private governanceContract(): Contract {
    if (!this.config.governanceId?.trim()) {
      throw new Error(
        "governanceId is required to use the governance client",
      );
    }
    return new Contract(this.config.governanceId);
  }

  private async simulateRead(operation: xdr.Operation): Promise<xdr.ScVal> {
    const sourceAccount = new Account(this.config.simAccount, "0");
    const tx = new TransactionBuilder(sourceAccount, {
      fee: this.config.baseFee ?? BASE_FEE,
      networkPassphrase: this.config.networkPassphrase,
    })
      .addOperation(operation)
      .setTimeout(this.config.timeoutSeconds ?? 30)
      .build();

    const sim = await this.server.simulateTransaction(tx);
    if (SorobanRpc.Api.isSimulationError(sim)) {
      throwContractError(sim.error, "governance");
    }
    if (!SorobanRpc.Api.isSimulationSuccess(sim)) {
      throw new Error("Simulation returned unexpected response");
    }
    const retval = sim.result?.retval;
    if (!retval) {
      throw new Error("No return value in simulation result");
    }
    return retval;
  }

  private async submitSignedTransaction(
    keypair: Keypair,
    operation: xdr.Operation,
    operationName: string,
  ): Promise<{ hash: string; retval?: xdr.ScVal }> {
    const publicKey = getPublicKey(keypair);
    const accountData = await this.server.getAccount(publicKey);
    const sourceAccount = new Account(
      publicKey,
      accountData.sequenceNumber(),
    );
    const tx = new TransactionBuilder(sourceAccount, {
      fee: this.config.baseFee ?? BASE_FEE,
      networkPassphrase: this.config.networkPassphrase,
    })
      .addOperation(operation)
      .setTimeout(this.config.timeoutSeconds ?? 30)
      .build();

    const sim = await this.server.simulateTransaction(tx);
    if (SorobanRpc.Api.isSimulationError(sim)) {
      throwContractError(sim.error, "governance");
    }
    if (!SorobanRpc.Api.isSimulationSuccess(sim)) {
      throw new Error(`${operationName} simulation returned unexpected response`);
    }

    const retval = sim.result?.retval;
    const preparedTx = SorobanRpc.assembleTransaction(tx, sim).build();
    preparedTx.sign(keypair);
    const response = await this.server.sendTransaction(preparedTx);
    if (response.status !== "PENDING") {
      throw new Error(
        `${operationName} transaction submission failed: ${response.errorResult}`,
      );
    }

    await waitForTransactionConfirmation(
      this.server,
      response.hash,
      operationName,
    );
    return { hash: response.hash, retval };
  }
}

export class StellarDIDCreditSDK {
  private server: SorobanRpc.Server;
  public readonly governance: GovernanceClient;

  constructor(config: ProtocolConfig) {
    if (config.network && config.network !== 'custom') {
      const networkDefaults = NETWORK_CONFIGS[config.network];
      this.config = {
        ...networkDefaults,
        ...config,
      } as ProtocolConfig;
    } else {
      this.config = config;
    }

    this.server = new SorobanRpc.Server(this.config.rpcUrl);
    this.governance = new GovernanceClient(this.config, this.server);
  }

  private config: ProtocolConfig;

  async anchorDID(
    subjectKeypair: KeypairLike,
    didDocCid: string,
    subjectAddress?: string,
  ): Promise<string> {
    const publicKey =
      typeof subjectKeypair.publicKey === "function"
        ? subjectKeypair.publicKey()
        : subjectKeypair.publicKey;

    if (subjectAddress && publicKey !== subjectAddress) {
      throw new Error("subjectKeypair public key does not match subject");
    }

    const server = this.server;
    const contract = new Contract(this.config.identityOracleId);

    const accountData = await server.getAccount(publicKey);
    const sourceAccount = new Account(publicKey, accountData.sequenceNumber());

    const tx = new TransactionBuilder(sourceAccount, {
      fee: BASE_FEE,
      networkPassphrase: this.config.networkPassphrase,
    })
      .addOperation(
        contract.call(
          "anchor_did",
          new Address(publicKey).toScVal(),
          nativeToScVal(didDocCid),
        ),
      )
      .setTimeout(this.config.timeoutSeconds ?? 30)
      .build();

    const sim = await server.simulateTransaction(tx);

    if (SorobanRpc.Api.isSimulationError(sim)) {
      throwContractError(sim.error, "identity-oracle");
    }

    if (!SorobanRpc.Api.isSimulationSuccess(sim)) {
      throw new Error("Simulation returned unexpected response");
    }

    const preparedTx = SorobanRpc.assembleTransaction(tx, sim).build();
    preparedTx.sign(subjectKeypair as Keypair);

    const txHash = await sendTransactionWithRetry(
      server,
      preparedTx,
      this.config.maxRetries,
      (response) =>
        new Error(`Transaction submission failed: ${response.errorResult}`),
    );

    await waitForTransactionConfirmation(
      server,
      txHash,
      "anchorDID",
      getConfirmationTimeoutMs(this.config),
      getTransactionPollIntervalMs(this.config),
    );

    return txHash;
  }

  async issueVC(
    issuerKeypair: KeypairLike,
    subjectAddress: string,
    vcHash: Buffer,
  ): Promise<string> {
    if (vcHash.length !== 32) {
      throw new Error("vcHash must be exactly 32 bytes");
    }

    const server = this.server;
    const contract = new Contract(this.config.identityOracleId);

    const publicKey =
      typeof issuerKeypair.publicKey === "function"
        ? issuerKeypair.publicKey()
        : issuerKeypair.publicKey;

    const accountData = await server.getAccount(publicKey);
    const sourceAccount = new Account(publicKey, accountData.sequenceNumber());

    const hashScVal = nativeToScVal(new Uint8Array(vcHash), { type: "bytes" });

    const tx = new TransactionBuilder(sourceAccount, {
      fee: BASE_FEE,
      networkPassphrase: this.config.networkPassphrase,
    })
      .addOperation(
        contract.call(
          "anchor_vc",
          new Address(publicKey).toScVal(),
          new Address(subjectAddress).toScVal(),
          hashScVal,
        ),
      )
      .setTimeout(this.config.timeoutSeconds ?? 30)
      .build();

    const sim = await server.simulateTransaction(tx);

    if (SorobanRpc.Api.isSimulationError(sim)) {
      throwContractError(sim.error, "identity-oracle");
    }

    if (!SorobanRpc.Api.isSimulationSuccess(sim)) {
      throw new Error("Simulation returned unexpected response");
    }

    const preparedTx = SorobanRpc.assembleTransaction(tx, sim).build();
    preparedTx.sign(issuerKeypair as Keypair);

    const txHash = await sendTransactionWithRetry(
      server,
      preparedTx,
      this.config.maxRetries,
      (response) =>
        new Error(`Transaction submission failed: ${response.errorResult}`),
    );

    await waitForTransactionConfirmation(
      server,
      txHash,
      "issueVC",
      getConfirmationTimeoutMs(this.config),
      getTransactionPollIntervalMs(this.config),
    );

    return txHash;
  }

  async computeScore(
    payerKeypair: KeypairLike,
    subjectAddress: string,
  ): Promise<number> {
    const contract = new Contract(this.config.creditOracleId);

    const publicKey = getPublicKey(payerKeypair);

    const accountData = await this.server.getAccount(publicKey);
    const sourceAccount = new Account(publicKey, accountData.sequenceNumber());

    const tx = new TransactionBuilder(sourceAccount, {
      fee: this.config.baseFee ?? BASE_FEE,
      networkPassphrase: this.config.networkPassphrase,
    })
      .addOperation(
        contract.call("compute_score", new Address(subjectAddress).toScVal()),
      )
      .setTimeout(this.config.timeoutSeconds ?? 30)
      .build();

    const sim = await this.server.simulateTransaction(tx);

    if (SorobanRpc.Api.isSimulationError(sim)) {
      if (sim.error && sim.error.toLowerCase().includes("cooldown")) {
        throw new SDKError(
          "COOLDOWN_ACTIVE",
          "Cooldown period is active. Please wait for the cooldown ledgers to pass before recomputing the score.",
        );
      }
      throwContractError(sim.error ?? "Simulation failed", "credit-oracle");
    }

    if (!SorobanRpc.Api.isSimulationSuccess(sim)) {
      throw new SDKError(
        "TRANSACTION_FAILED",
        "Simulation returned unexpected response",
      );
    }

    const preparedTx = SorobanRpc.assembleTransaction(tx, sim).build();
    preparedTx.sign(payerKeypair as Keypair);

    const txHash = await sendTransactionWithRetry(
      this.server,
      preparedTx,
      this.config.maxRetries,
      (submissionResponse) => {
        if (
          submissionResponse.errorResult &&
          String(submissionResponse.errorResult)
            .toLowerCase()
            .includes("cooldown")
        ) {
          return new SDKError(
            "COOLDOWN_ACTIVE",
            "Cooldown period is active. Please wait for the cooldown ledgers to pass before recomputing the score.",
          );
        }
        return new SDKError(
          "TRANSACTION_FAILED",
          `Transaction submission failed: ${String(submissionResponse.errorResult)}`,
        );
      },
    );

    try {
      await waitForTransactionConfirmation(
        this.server,
        txHash,
        "computeScore",
        getConfirmationTimeoutMs(this.config),
        getTransactionPollIntervalMs(this.config),
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (message.toLowerCase().includes("cooldown")) {
        throw new SDKError(
          "COOLDOWN_ACTIVE",
          "Cooldown period is active. Please wait for the cooldown ledgers to pass before recomputing the score.",
        );
      }
      throw error;
    }

    try {
      const score = await this.getScore(subjectAddress);
      if (!score) {
        throw new ScoreNotComputedError(subjectAddress);
      }
      return score.score;
    } catch (error) {
      if (error instanceof SDKError) {
        throw error;
      }
      const message = error instanceof Error ? error.message : String(error);
      throw new SDKError(
        "TRANSACTION_FAILED",
        `computeScore transaction succeeded and was confirmed, but fetching the stored score for ${subjectAddress} failed: ${message}`,
      );
    }
  }

  async getScore(subjectAddress: string): Promise<ScoreRecord | null> {
    const server = this.server;
    const contract = new Contract(this.config.creditOracleId);
    const sourceAccount = new Account(this.config.simAccount, "0");

    let attempts = 0;
    const maxAttempts = (this.config.maxRetries ?? 0) + 1;

    while (attempts < maxAttempts) {
      const tx = new TransactionBuilder(sourceAccount, {
        fee: this.config.baseFee || BASE_FEE,
        networkPassphrase: this.config.networkPassphrase,
      })
        .addOperation(
          contract.call("get_score", new Address(subjectAddress).toScVal()),
        )
        .setTimeout(this.config.timeoutSeconds ?? 30)
        .build();

      const sim = await server.simulateTransaction(tx);

      if (SorobanRpc.Api.isSimulationError(sim)) {
        if (sim.error && sim.error.includes("score not computed")) {
          return null;
        }
        throwContractError(sim.error, "credit-oracle");
      }

      if (SorobanRpc.Api.isSimulationSuccess(sim)) {
        const resultScVal = sim.result?.retval;
        if (!resultScVal) {
          throw new Error("No return value in simulation result");
        }
        return parseScoreRecord(resultScVal);
      }

      attempts++;
      if (attempts < maxAttempts) {
        await new Promise((resolve) => setTimeout(resolve, 500 * attempts));
      }
    }

    throw new Error("Simulation returned unexpected response");
  }

  async getDIDDocument(subjectAddress: string): Promise<string | null> {
    const server = this.server;
    const contract = new Contract(this.config.identityOracleId);
    const sourceAccount = new Account(this.config.simAccount, "0");

    const tx = new TransactionBuilder(sourceAccount, {
      fee: this.config.baseFee || BASE_FEE,
      networkPassphrase: this.config.networkPassphrase,
    })
      .addOperation(
        contract.call("get_did_document", new Address(subjectAddress).toScVal()),
      )
      .setTimeout(this.config.timeoutSeconds ?? 30)
      .build();

    const sim = await server.simulateTransaction(tx);

    if (SorobanRpc.Api.isSimulationError(sim)) {
      throwContractError(sim.error, "identity-oracle");
    }

    if (!SorobanRpc.Api.isSimulationSuccess(sim)) {
      throw new Error("Simulation returned unexpected response");
    }

    const resultScVal = sim.result?.retval;
    if (!resultScVal) {
      throw new Error("No return value in simulation result");
    }

    const native = scValToNative(resultScVal);
    if (native === null || native === undefined) {
      return null;
    }
    return native as string;
  }

  async revokeVC(
    issuerKeypair: KeypairLike,
    vcHash: Buffer,
  ): Promise<string> {
    if (vcHash.length !== 32) {
      throw new SDKError(
        "INVALID_VC_HASH",
        "vcHash must be exactly 32 bytes",
      );
    }

    if (!this.config.revocationRegistryId.trim()) {
      throw new SDKError(
        "MISSING_REVOCATION_REGISTRY",
        "revocationRegistryId is required to revoke a VC",
      );
    }

    const server = this.server;
    const registryContract = new Contract(this.config.revocationRegistryId);

    const publicKey =
      typeof issuerKeypair.publicKey === "function"
        ? issuerKeypair.publicKey()
        : issuerKeypair.publicKey;

    const accountData = await server.getAccount(publicKey);
    const sourceAccount = new Account(publicKey, accountData.sequenceNumber());

    const hashScVal = nativeToScVal(new Uint8Array(vcHash), { type: "bytes" });

    const tx = new TransactionBuilder(sourceAccount, {
      fee: BASE_FEE,
      networkPassphrase: this.config.networkPassphrase,
    })
      .addOperation(
        registryContract.call(
          "revoke",
          new Address(publicKey).toScVal(),
          hashScVal,
        ),
      )
      .setTimeout(this.config.timeoutSeconds ?? 30)
      .build();

    const sim = await server.simulateTransaction(tx);

    if (SorobanRpc.Api.isSimulationError(sim)) {
      throwContractError(sim.error, "revocation-registry");
    }

    if (!SorobanRpc.Api.isSimulationSuccess(sim)) {
      throw new SDKError(
        "TRANSACTION_FAILED",
        "revokeVC simulation returned an unexpected response; no revocation state was changed",
      );
    }

    const preparedTx = SorobanRpc.assembleTransaction(tx, sim).build();
    preparedTx.sign(issuerKeypair as Keypair);

    const txHash = await sendTransactionWithRetry(
      server,
      preparedTx,
      this.config.maxRetries,
      (response) =>
        createRevokeError(
          `revokeVC submission failed; no revocation was applied: ${response.errorResult}`,
          response.errorResult,
        ),
    );

    try {
      await waitForTransactionConfirmation(
        server,
        txHash,
        "revokeVC",
        getConfirmationTimeoutMs(this.config),
        getTransactionPollIntervalMs(this.config),
      );
    } catch (error) {
      throw createRevokeError(
        `revokeVC failed; the atomic transaction rolled back both registry and identity-oracle changes: ${getErrorMessage(error)}`,
        error,
      );
    }

    return txHash;
  }

  async batchRevokeVC(
    issuerKeypair: KeypairLike,
    vcHashes: Buffer[],
  ): Promise<BatchResult> {
    if (!this.config.revocationRegistryId.trim()) {
      throw new SDKError(
        "MISSING_REVOCATION_REGISTRY",
        "revocationRegistryId is required to revoke VCs",
      );
    }

    for (const vcHash of vcHashes) {
      if (vcHash.length !== 32) {
        throw new SDKError(
          "INVALID_VC_HASH",
          "Each vcHash must be exactly 32 bytes",
        );
      }
    }

    if (vcHashes.length === 0) {
      return {
        success: true,
        failedChunks: 0,
        transactionHashes: [],
        chunks: [],
      };
    }

    let maxBatchSize = 50;
    try {
      const limitContract = new Contract(this.config.revocationRegistryId);
      const limitSource = new Account(this.config.simAccount, "0");
      const limitTx = new TransactionBuilder(limitSource, {
        fee: this.config.baseFee ?? BASE_FEE,
        networkPassphrase: this.config.networkPassphrase,
      })
        .addOperation(limitContract.call("get_batch_limit"))
        .setTimeout(this.config.timeoutSeconds ?? 30)
        .build();
      const limitSim = await this.server.simulateTransaction(limitTx);
      if (
        SorobanRpc.Api.isSimulationSuccess(limitSim) &&
        limitSim.result?.retval
      ) {
        const parsedLimit = Number(scValToNative(limitSim.result.retval));
        if (Number.isInteger(parsedLimit) && parsedLimit > 0) {
          maxBatchSize = parsedLimit;
        }
      }
    } catch {
      // fall back to 50
    }

    const result: BatchResult = {
      success: true,
      failedChunks: 0,
      transactionHashes: [],
      chunks: [],
    };

    let chunkIndex = 0;
    for (let i = 0; i < vcHashes.length; i += maxBatchSize) {
      const chunk = vcHashes.slice(i, i + maxBatchSize);
      try {
        const transactionHash = await this.submitBatchRevokeChunk(
          issuerKeypair,
          chunk,
        );
        result.transactionHashes.push(transactionHash);
        result.chunks.push({
          chunkIndex,
          vcHashes: chunk,
          status: "fulfilled",
          transactionHash,
        });
      } catch (error) {
        result.success = false;
        result.failedChunks += 1;
        result.chunks.push({
          chunkIndex,
          vcHashes: chunk,
          status: "rejected",
          error:
            error instanceof SDKError
              ? error
              : createRevokeError(
                  `batchRevokeVC chunk failed: ${getErrorMessage(error)}`,
                  error,
                ),
        });
      }
      chunkIndex += 1;
    }

    return result;
  }

  async isVerified(subjectAddress: string): Promise<boolean> {
    const server = this.server;
    const contract = new Contract(this.config.identityOracleId);

    const sourceAccount = new Account(this.config.simAccount, "0");
    const tx = new TransactionBuilder(sourceAccount, {
      fee: BASE_FEE,
      networkPassphrase: this.config.networkPassphrase,
    })
      .addOperation(
        contract.call("is_verified", new Address(subjectAddress).toScVal()),
      )
      .setTimeout(30)
      .build();

    const sim = await server.simulateTransaction(tx);

    if (SorobanRpc.Api.isSimulationError(sim)) {
      throwContractError(sim.error, "identity-oracle");
    }

    if (!SorobanRpc.Api.isSimulationSuccess(sim)) {
      throw new Error("Simulation returned unexpected response");
    }

    const resultScVal = sim.result?.retval;
    if (!resultScVal) {
      throw new Error("No return value in simulation result");
    }

    return scValToNative(resultScVal) as boolean;
  }

  async verifyVC(subjectAddress: string, vcHash: Buffer): Promise<boolean> {
    if (vcHash.length !== 32) {
      throw new Error("vcHash must be exactly 32 bytes");
    }

    const server = this.server;
    const contract = new Contract(this.config.identityOracleId);
    const sourceAccount = new Account(this.config.simAccount, "0");

    const hashScVal = nativeToScVal(new Uint8Array(vcHash), { type: "bytes" });

    const tx = new TransactionBuilder(sourceAccount, {
      fee: BASE_FEE,
      networkPassphrase: this.config.networkPassphrase,
    })
      .addOperation(
        contract.call(
          "verify_vc",
          new Address(subjectAddress).toScVal(),
          hashScVal,
        ),
      )
      .setTimeout(30)
      .build();

    const sim = await server.simulateTransaction(tx);

    if (SorobanRpc.Api.isSimulationError(sim)) {
      if (isVerifyVCNegativeSimulationError(sim.error)) {
        return false;
      }
      throwContractError(sim.error, "identity-oracle");
    }

    if (!SorobanRpc.Api.isSimulationSuccess(sim)) {
      throw new Error("Simulation returned unexpected response");
    }

    const resultScVal = sim.result?.retval;
    if (!resultScVal) {
      throw new Error("No return value in simulation result");
    }

    const native = scValToNative(resultScVal);
    if (typeof native !== "boolean") {
      throw new Error("verify_vc returned a non-boolean result");
    }

    return native;
  }

  async getVCCount(subjectAddress: string): Promise<number> {
    const server = this.server;
    const contract = new Contract(this.config.identityOracleId);
    const sourceAccount = new Account(this.config.simAccount, "0");

    const tx = new TransactionBuilder(sourceAccount, {
      fee: BASE_FEE,
      networkPassphrase: this.config.networkPassphrase,
    })
      .addOperation(
        contract.call("get_active_vc_count", new Address(subjectAddress).toScVal()),
      )
      .setTimeout(30)
      .build();

    const sim = await server.simulateTransaction(tx);

    if (SorobanRpc.Api.isSimulationError(sim)) {
      throwContractError(sim.error, "identity-oracle");
    }

    if (!SorobanRpc.Api.isSimulationSuccess(sim)) {
      throw new Error("Simulation returned unexpected response");
    }

    const resultScVal = sim.result?.retval;
    if (!resultScVal) {
      throw new Error("No return value in simulation result");
    }

    return scValToNative(resultScVal) as number;
  }

  async getVCs(subjectAddress: string): Promise<VCRecord[]> {
    const server = this.server;
    const contract = new Contract(this.config.identityOracleId);
    const sourceAccount = new Account(this.config.simAccount, "0");

    const tx = new TransactionBuilder(sourceAccount, {
      fee: BASE_FEE,
      networkPassphrase: this.config.networkPassphrase,
    })
      .addOperation(
        contract.call("get_vc_details", new Address(subjectAddress).toScVal()),
      )
      .setTimeout(30)
      .build();

    const sim = await server.simulateTransaction(tx);

    if (SorobanRpc.Api.isSimulationError(sim)) {
      throwContractError(sim.error, "identity-oracle");
    }

    if (!SorobanRpc.Api.isSimulationSuccess(sim)) {
      throw new Error("Simulation returned unexpected response");
    }

    const resultScVal = sim.result?.retval;
    if (!resultScVal) {
      throw new Error("No return value in simulation result");
    }

    return parseVCRecordList(resultScVal);
  }

  async getCredentialType(
    subjectAddress: string,
    vcHash: Buffer,
  ): Promise<string> {
    if (vcHash.length !== 32) {
      throw new Error("vcHash must be exactly 32 bytes");
    }

    const server = this.server;
    const contract = new Contract(this.config.identityOracleId);
    const sourceAccount = new Account(this.config.simAccount, "0");

    const hashScVal = nativeToScVal(new Uint8Array(vcHash), { type: "bytes" });

    const tx = new TransactionBuilder(sourceAccount, {
      fee: BASE_FEE,
      networkPassphrase: this.config.networkPassphrase,
    })
      .addOperation(
        contract.call(
          "get_vc_credential_type",
          new Address(subjectAddress).toScVal(),
          hashScVal,
        ),
      )
      .setTimeout(30)
      .build();

    const sim = await server.simulateTransaction(tx);

    if (SorobanRpc.Api.isSimulationError(sim)) {
      throwContractError(sim.error, "identity-oracle");
    }

    if (!SorobanRpc.Api.isSimulationSuccess(sim)) {
      throw new Error("Simulation returned unexpected response");
    }

    const resultScVal = sim.result?.retval;
    if (!resultScVal) {
      throw new Error("No return value in simulation result");
    }

    return String(scValToNative(resultScVal));
  }

  async getWeights(): Promise<ScoringWeights> {
    const server = this.server;
    const contract = new Contract(this.config.creditOracleId);
    const sourceAccount = new Account(this.config.simAccount, "0");

    const tx = new TransactionBuilder(sourceAccount, {
      fee: BASE_FEE,
      networkPassphrase: this.config.networkPassphrase,
    })
      .addOperation(contract.call("get_scoring_weights"))
      .setTimeout(30)
      .build();

    const sim = await server.simulateTransaction(tx);

    if (SorobanRpc.Api.isSimulationError(sim)) {
      throwContractError(sim.error, "credit-oracle");
    }

    if (!SorobanRpc.Api.isSimulationSuccess(sim)) {
      throw new Error("Simulation returned unexpected response");
    }

    const resultScVal = sim.result?.retval;
    if (!resultScVal) {
      throw new Error("No return value in simulation result");
    }

    return parseScoringWeights(resultScVal);
  }

  async getRegisteredIssuers(): Promise<string[]> {
    const server = this.server;
    const contract = new Contract(this.config.identityOracleId);
    const sourceAccount = new Account(this.config.simAccount, "0");

    const tx = new TransactionBuilder(sourceAccount, {
      fee: BASE_FEE,
      networkPassphrase: this.config.networkPassphrase,
    })
      .addOperation(contract.call("list_issuers"))
      .setTimeout(30)
      .build();

    const sim = await server.simulateTransaction(tx);

    if (SorobanRpc.Api.isSimulationError(sim)) {
      throwContractError(sim.error, "identity-oracle");
    }

    if (!SorobanRpc.Api.isSimulationSuccess(sim)) {
      throw new Error("Simulation returned unexpected response");
    }

    const resultScVal = sim.result?.retval;
    if (!resultScVal) {
      throw new Error("No return value in simulation result");
    }

    const native = scValToNative(resultScVal);
    return (native as unknown[]).map((addr) => String(addr));
  }

  async listProposals(
    fromId: number | bigint,
    limit: number,
    includeInactive = false,
  ): Promise<GovernanceProposal[]> {
    if (!this.config.governanceId) {
      throw new Error("governanceId is not configured in ProtocolConfig");
    }

    const server = this.server;
    const contract = new Contract(this.config.governanceId);
    const sourceAccount = new Account(this.config.simAccount, "0");

    const tx = new TransactionBuilder(sourceAccount, {
      fee: BASE_FEE,
      networkPassphrase: this.config.networkPassphrase,
    })
      .addOperation(
        contract.call(
          "list_proposals",
          nativeToScVal(BigInt(fromId), { type: "u64" }),
          nativeToScVal(limit, { type: "u32" }),
          nativeToScVal(includeInactive, { type: "bool" }),
        ),
      )
      .setTimeout(30)
      .build();

    const sim = await server.simulateTransaction(tx);

    if (SorobanRpc.Api.isSimulationError(sim)) {
      throwContractError(sim.error, "governance");
    }

    if (!SorobanRpc.Api.isSimulationSuccess(sim)) {
      throw new Error("Simulation returned unexpected response");
    }

    const resultScVal = sim.result?.retval;
    if (!resultScVal) {
      throw new Error("No return value in simulation result");
    }

    return parseGovernanceProposalList(resultScVal);
  }

  onVCAnchored(
    contractId: string,
    callback: (issuer: string, subject: string, vcHash: Buffer) => void,
  ): Unsubscribe {
    return this.subscribeToEvents(
      contractId,
      "VCAnch",
      (value) => {
        const [issuer, subject, vcHash] = parseEventTuple(
          value,
          "VCAnch",
          3,
        );
        callback(String(issuer), String(subject), toBuffer(vcHash));
      },
    );
  }

  onScoreComputed(
    contractId: string,
    callback: (subject: string, score: number) => void,
  ): Unsubscribe {
    return this.subscribeToEvents(
      contractId,
      "Score",
      (value) => {
        const [subject, score] = parseEventTuple(value, "Score", 2);
        callback(String(subject), Number(score));
      },
    );
  }

  onVCRevoked(
    contractId: string,
    callback: (issuer: string, vcHash: Buffer) => void,
  ): Unsubscribe {
    return this.subscribeToEvents(
      contractId,
      "Revoked",
      (value) => {
        const [issuer, vcHash] = parseEventTuple(value, "Revoked", 2);
        callback(String(issuer), toBuffer(vcHash));
      },
    );
  }

  private async submitBatchRevokeChunk(
    issuerKeypair: KeypairLike,
    vcHashes: Buffer[],
  ): Promise<string> {
    const server = this.server;
    const registryContract = new Contract(this.config.revocationRegistryId);
    const publicKey = getPublicKey(issuerKeypair);

    const accountData = await server.getAccount(publicKey);
    const sourceAccount = new Account(publicKey, accountData.sequenceNumber());

    const tx = new TransactionBuilder(sourceAccount, {
      fee: this.config.baseFee ?? BASE_FEE,
      networkPassphrase: this.config.networkPassphrase,
    })
      .addOperation(
        registryContract.call(
          "batch_revoke",
          new Address(publicKey).toScVal(),
          xdr.ScVal.scvVec(
            vcHashes.map((vcHash) =>
              nativeToScVal(new Uint8Array(vcHash), { type: "bytes" }),
            ),
          ),
        ),
      )
      .setTimeout(this.config.timeoutSeconds ?? 30)
      .build();

    const sim = await server.simulateTransaction(tx);

    if (SorobanRpc.Api.isSimulationError(sim)) {
      throwContractError(sim.error, "revocation-registry");
    }

    if (!SorobanRpc.Api.isSimulationSuccess(sim)) {
      throw new SDKError(
        "TRANSACTION_FAILED",
        "batchRevokeVC simulation returned an unexpected response",
      );
    }

    const preparedTx = SorobanRpc.assembleTransaction(tx, sim).build();
    preparedTx.sign(issuerKeypair as Keypair);

    const txHash = await sendTransactionWithRetry(
      server,
      preparedTx,
      this.config.maxRetries,
      (response) =>
        createRevokeError(
          `batchRevokeVC submission failed: ${response.errorResult}`,
          response.errorResult,
        ),
    );

    try {
      await waitForTransactionConfirmation(
        server,
        txHash,
        "batchRevokeVC",
        getConfirmationTimeoutMs(this.config),
        getTransactionPollIntervalMs(this.config),
      );
    } catch (error) {
      throw createRevokeError(
        `batchRevokeVC failed; this chunk rolled back: ${getErrorMessage(error)}`,
        error,
      );
    }

    return txHash;
  }

  private subscribeToEvents(
    contractId: string,
    eventName: string,
    handleValue: (value: xdr.ScVal) => void,
  ): Unsubscribe {
    const pollIntervalMs = this.config.pollIntervalMs ?? 1000;
    if (!Number.isFinite(pollIntervalMs) || pollIntervalMs <= 0) {
      throw new Error("pollIntervalMs must be a positive number");
    }

    let active = true;
    let polling = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let lastSeenLedger: number | undefined;

    const poll = async (): Promise<void> => {
      if (!active || polling) {
        return;
      }

      polling = true;
      try {
        if (lastSeenLedger === undefined) {
          const latestLedger = await this.server.getLatestLedger();
          lastSeenLedger = latestLedger.sequence;
        }

        if (!active) {
          return;
        }

        const response = await this.server.getEvents({
          startLedger: lastSeenLedger,
          filters: [
            {
              type: "contract",
              contractIds: [contractId],
              topics: [[xdr.ScVal.scvSymbol(eventName).toXDR("base64")]],
            },
          ],
          limit: 100,
        });

        const latestEventLedger = response.events.reduce(
          (highestLedger, event) => Math.max(highestLedger, event.ledger),
          lastSeenLedger,
        );
        lastSeenLedger =
          Math.max(response.latestLedger, latestEventLedger) + 1;

        for (const event of response.events) {
          if (!active) {
            break;
          }
          handleValue(event.value);
        }
      } catch {
        // Keep polling after transient RPC failures.
      } finally {
        polling = false;
        if (active) {
          timer = setTimeout(() => void poll(), pollIntervalMs);
        }
      }
    };

    void poll();

    return () => {
      active = false;
      if (timer !== undefined) {
        clearTimeout(timer);
        timer = undefined;
      }
    };
  }
}

/** Thrown when get_score is called for an address that has no computed score yet. */
export class ScoreNotComputedError extends Error {
  constructor(address?: string) {
    super(address ? `No score computed for address: ${address}` : "Score has not been computed");
    this.name = "ScoreNotComputedError";
  }
}

function getPublicKey(keypair: KeypairLike): string {
  return typeof keypair.publicKey === "function"
    ? keypair.publicKey()
    : keypair.publicKey;
}

function toUnsignedBigInt(value: GovernanceInteger): bigint {
  assertSafeInteger(value);
  const result = BigInt(value);
  if (result < 0n) {
    throw new Error("integer values must be non-negative");
  }
  return result;
}

function toPositiveBigInt(value: GovernanceInteger): bigint {
  assertSafeInteger(value);
  const result = BigInt(value);
  if (result <= 0n) {
    throw new Error("voteWeight must be positive");
  }
  return result;
}

function assertSafeInteger(value: GovernanceInteger): void {
  if (typeof value === "number" && !Number.isSafeInteger(value)) {
    throw new Error("number values must be safe integers; use bigint instead");
  }
}

function scoringWeightsToScVal(weights: ScoringWeights): xdr.ScVal {
  return nativeToScVal(
    {
      vc_weight: weights.vcWeight,
      tx_weight: weights.txWeight,
      repayment_weight: weights.repaymentWeight,
    },
    {
      type: {
        vc_weight: ["symbol", "u32"],
        tx_weight: ["symbol", "u32"],
        repayment_weight: ["symbol", "u32"],
      },
    },
  );
}

/**
 * Parse a Soroban ScVal representing an Option<ScoreRecord>.
 * Returns the ScoreRecord if Some, returns null if None.
 * Throws an Error if any required field is missing after scValToNative.
 */
export function parseScoreRecord(scVal: xdr.ScVal): ScoreRecord | null {
  const native = scValToNative(scVal);
  if (native === null || native === undefined) {
    return null;
  }
  const raw = native as Record<string, unknown>;

  const requiredFields = [
    'score',
    'last_updated',
    'vc_count',
    'repayment_rate',
    'tx_volume_30d',
    'previous_score',
    'computed_at_ledger',
    'stale',
  ] as const;

  for (const field of requiredFields) {
    if (!(field in raw)) {
      throw new Error(`parseScoreRecord: missing field '${field}' in ScoreRecord`);
    }
  }

  return {
    score: Number(raw["score"]),
    lastUpdated: Number(raw["last_updated"]),
    vcCount: Number(raw["vc_count"]),
    repaymentRate: Number(raw["repayment_rate"]),
    txVolume30d: BigInt(raw["tx_volume_30d"] as bigint),
    previousScore: raw["previous_score"] != null ? Number(raw["previous_score"]) : null,
    computedAtLedger: Number(raw["computed_at_ledger"]),
    stale: Boolean(raw["stale"]),
  };
}

function parseScoringWeights(scVal: xdr.ScVal): ScoringWeights {
  const native = scValToNative(scVal);
  if (native === null || native === undefined || typeof native !== "object") {
    throw new Error("get_scoring_weights returned an invalid result");
  }

  const raw = native as Record<string, unknown>;
  return {
    vcWeight: Number(raw["vc_weight"]),
    txWeight: Number(raw["tx_weight"]),
    repaymentWeight: Number(raw["repayment_weight"]),
  };
}

function parseGovernanceProposal(native: unknown): GovernanceProposal {
  if (typeof native !== "object" || native === null) {
    throw new Error("get_proposal returned an invalid result");
  }

  const raw = native as Record<string, unknown>;
  const weights = raw["proposed_weights"];
  if (typeof weights !== "object" || weights === null) {
    throw new Error("get_proposal returned invalid proposed weights");
  }

  const rawWeights = weights as Record<string, unknown>;
  return {
    id: BigInt(raw["id"] as bigint | number | string),
    proposer: String(raw["proposer"]),
    proposedWeights: {
      vcWeight: Number(rawWeights["vc_weight"]),
      txWeight: Number(rawWeights["tx_weight"]),
      repaymentWeight: Number(rawWeights["repayment_weight"]),
    },
    votesFor: BigInt(raw["votes_for"] as bigint | number | string),
    votesAgainst: BigInt(
      raw["votes_against"] as bigint | number | string,
    ),
    expiryLedger: Number(raw["expiry_ledger"]),
    executionDelayLedgers: Number(raw["execution_delay_ledgers"]),
    executed: Boolean(raw["executed"]),
    cancelled: Boolean(raw["cancelled"]),
    quorumRequired: BigInt(
      raw["quorum_required"] as bigint | number | string,
    ),
  };
}

function parseVCRecordList(scVal: xdr.ScVal): VCRecord[] {
  const native = scValToNative(scVal);
  if (native === null || native === undefined) {
    return [];
  }
  return (native as unknown[]).map((entry) => {
    const raw = entry as Record<string, unknown>;
    const vcHash = raw["vc_hash"] as Buffer | Uint8Array | undefined;
    return {
      vcHash: Buffer.isBuffer(vcHash)
        ? vcHash
        : Buffer.from(vcHash ?? new Uint8Array()),
      issuer: String(raw["issuer"]),
      anchoredAt: Number(raw["anchored_at"]),
      revoked: Boolean(raw["revoked"]),
    };
  });
}

function parseGovernanceProposalList(scVal: xdr.ScVal): GovernanceProposal[] {
  const native = scValToNative(scVal);
  if (native === null || native === undefined) {
    return [];
  }
  return (native as unknown[]).map((entry) => {
    const raw = entry as Record<string, unknown>;
    const weights = raw["proposed_weights"] as Record<string, unknown>;
    return {
      id: BigInt(raw["id"] as bigint | number | string),
      proposer: String(raw["proposer"]),
      proposedWeights: {
        vcWeight: Number(weights["vc_weight"]),
        txWeight: Number(weights["tx_weight"]),
        repaymentWeight: Number(weights["repayment_weight"]),
      },
      votesFor: BigInt(raw["votes_for"] as bigint | number | string),
      votesAgainst: BigInt(raw["votes_against"] as bigint | number | string),
      expiryLedger: Number(raw["expiry_ledger"]),
      executionDelayLedgers: Number(raw["execution_delay_ledgers"]),
      executed: Boolean(raw["executed"]),
      cancelled: Boolean(raw["cancelled"]),
      quorumRequired: BigInt(raw["quorum_required"] as bigint | number | string),
    };
  });
}

type SendTransactionErrorFactory = (
  response: SorobanRpc.Api.SendTransactionResponse,
) => Error;

async function sendTransactionWithRetry(
  server: SorobanRpc.Server,
  transaction: Parameters<SorobanRpc.Server["sendTransaction"]>[0],
  maxRetries = 3,
  errorFactory: SendTransactionErrorFactory,
): Promise<string> {
  const retries = normalizeMaxRetries(maxRetries);

  for (let attempt = 0; ; attempt++) {
    let response: SorobanRpc.Api.SendTransactionResponse;
    try {
      response = await server.sendTransaction(transaction);
    } catch (error) {
      if (!isRetryableError(error) || attempt >= retries) {
        throw error;
      }

      await sleep(getRetryDelayMs(attempt));
      continue;
    }

    if (response.status === "PENDING" || response.status === "DUPLICATE") {
      return response.hash;
    }

    if (response.status !== "TRY_AGAIN_LATER" || attempt >= retries) {
      throw errorFactory(response);
    }

    await sleep(getRetryDelayMs(attempt));
  }
}

function parseEventTuple(
  scVal: xdr.ScVal,
  eventName: string,
  expectedLength: number,
): unknown[] {
  const native = scValToNative(scVal);
  if (!Array.isArray(native) || native.length !== expectedLength) {
    throw new Error(
      `${eventName} event data must be a tuple with ${expectedLength} values`,
    );
  }
  return native;
}

function toBuffer(value: unknown): Buffer {
  if (Buffer.isBuffer(value)) {
    return value;
  }
  if (value instanceof Uint8Array) {
    return Buffer.from(value);
  }
  throw new Error("event data contains an invalid byte value");
}

async function waitForTransactionConfirmation(
  server: SorobanRpc.Server,
  txHash: string,
  operationName: string,
  timeoutMs = 20_000,
  delayMs = 1000,
): Promise<void> {
  const normalizedTimeoutMs = Number.isFinite(timeoutMs)
    ? Math.max(0, timeoutMs)
    : 30_000;
  const pollDelayMs = Number.isFinite(delayMs) ? Math.max(1, delayMs) : 1000;
  const deadline = Date.now() + normalizedTimeoutMs;

  for (;;) {
    if (Date.now() >= deadline) {
      throwTransactionTimeout(operationName, txHash);
    }

    let result: Awaited<ReturnType<SorobanRpc.Server["getTransaction"]>>;
    try {
      result = await withTimeout(
        server.getTransaction(txHash),
        deadline - Date.now(),
        () => createTransactionTimeoutError(operationName, txHash),
      );
    } catch (error) {
      if (error instanceof SDKError) {
        throw error;
      }
      if (!isRetryableError(error)) {
        throw error;
      }
      if (Date.now() >= deadline) {
        throwTransactionTimeout(operationName, txHash);
      }
      await sleep(Math.min(pollDelayMs, deadline - Date.now()));
      continue;
    }

    switch (result.status as string) {
      case "SUCCESS":
        return;
      case "FAILED": {
        const resultXdr = extractResultXdr(result);
        throw new SDKError(
          "TRANSACTION_FAILED",
          `${operationName} transaction failed for ${txHash}; resultXdr: ${resultXdr ?? "unknown"}`,
          {
            cause: result,
            transactionHash: txHash,
            resultXdr,
          },
        );
      }
      case "NOT_FOUND":
      case "PENDING":
        if (Date.now() >= deadline) {
          throwTransactionTimeout(operationName, txHash);
        }
        await sleep(Math.min(pollDelayMs, deadline - Date.now()));
        break;
      default:
        throw new Error(
          `Unexpected transaction status for ${txHash}: ${String(result.status)}`,
        );
    }
  }
}

function createTransactionTimeoutError(
  operationName: string,
  txHash: string,
): SDKError {
  return new SDKError(
    "TRANSACTION_TIMEOUT",
    `Timed out waiting for ${operationName} transaction confirmation: ${txHash}`,
  );
}

function throwTransactionTimeout(operationName: string, txHash: string): never {
  throw createTransactionTimeoutError(operationName, txHash);
}

function getConfirmationTimeoutMs(config: ProtocolConfig): number {
  return (
    config.confirmationTimeoutMs ??
    (config.timeoutSeconds ?? 30) * 1000
  );
}

function getTransactionPollIntervalMs(config: ProtocolConfig): number {
  const configured = config.pollIntervalMs;
  if (!Number.isFinite(configured) || configured === undefined) {
    return 5000;
  }
  return Math.max(1, configured);
}

function extractResultXdr(value: unknown): string | undefined {
  if (typeof value !== "object" || value === null) {
    return undefined;
  }

  const candidate = value as Record<string, unknown>;
  const raw =
    candidate["resultXdr"] ??
    candidate["result_xdr"] ??
    candidate["errorResultXdr"] ??
    candidate["error_result_xdr"];
  return raw === undefined || raw === null ? undefined : String(raw);
}

function normalizeMaxRetries(maxRetries: number): number {
  return Number.isFinite(maxRetries) ? Math.max(0, Math.floor(maxRetries)) : 3;
}

function getRetryDelayMs(attempt: number): number {
  return 1000 * 2 ** attempt;
}

function isRetryableError(error: unknown): boolean {
  const candidate = error as {
    code?: unknown;
    status?: unknown;
    statusCode?: unknown;
    response?: { status?: unknown; statusCode?: unknown };
  } | null;

  const httpStatus = [
    candidate?.status,
    candidate?.statusCode,
    candidate?.response?.status,
    candidate?.response?.statusCode,
  ]
    .map((status) => Number(status))
    .find((status) => Number.isInteger(status) && status > 0);
  if (httpStatus !== undefined) {
    return [408, 429, 500, 502, 503, 504].includes(httpStatus);
  }

  const code = String(candidate?.code ?? "").toUpperCase();
  if (
    ["ECONNRESET", "ECONNREFUSED", "ENETUNREACH", "ETIMEDOUT", "EAI_AGAIN"].includes(
      code,
    )
  ) {
    return true;
  }

  const message =
    error instanceof Error
      ? error.message.toLowerCase()
      : String(error).toLowerCase();
  return /\b503\b|timeout|timed out|network|fetch failed|unavailable|socket/.test(message);
}

function createRevokeError(message: string, details: unknown): SDKError {
  if (containsIssuerMismatch(details)) {
    return new SDKError(
      "NOT_REGISTERED_ISSUER",
      "The issuer is not registered for this VC hash",
      { cause: details },
    );
  }

  if (
    details instanceof SDKError &&
    details.code === "TRANSACTION_TIMEOUT"
  ) {
    return new SDKError("TRANSACTION_TIMEOUT", message, {
      cause: details,
      transactionHash: details.transactionHash,
      resultXdr: details.resultXdr,
    });
  }

  if (
    details instanceof SDKError &&
    details.code === "TRANSACTION_FAILED"
  ) {
    if (containsIssuerMismatch(details.cause)) {
      return new SDKError(
        "NOT_REGISTERED_ISSUER",
        "The issuer is not registered for this VC hash",
        {
          cause: details,
          transactionHash: details.transactionHash,
          resultXdr: details.resultXdr,
        },
      );
    }

    return new SDKError("TRANSACTION_FAILED", message, {
      cause: details,
      transactionHash: details.transactionHash,
      resultXdr: details.resultXdr,
    });
  }

  return new SDKError("TRANSACTION_FAILED", message, { cause: details });
}

function containsIssuerMismatch(value: unknown): boolean {
  if (value instanceof RevocationRegistryError && value.code === 3) {
    return true;
  }
  if (value instanceof IdentityOracleError && value.code === 3) {
    return true;
  }
  const text = getErrorMessage(value).toLowerCase();
  return (
    text.includes("issuermismatch") ||
    text.includes("issuer mismatch") ||
    /error\(contract,\s*#3\)/i.test(text)
  );
}

function getErrorMessage(value: unknown): string {
  if (value instanceof Error) {
    return value.message;
  }
  if (typeof value === "string") {
    return value;
  }
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function isVerifyVCNegativeSimulationError(error: unknown): boolean {
  if (error instanceof IdentityOracleError) {
    return error.code === 7 || error.code === 8;
  }
  const text = getErrorMessage(error).toLowerCase();
  return (
    text.includes("contractpaused") ||
    text.includes("contract paused") ||
    /error\(contract,\s*#8\)/i.test(text) ||
    text.includes("vcnotfound") ||
    text.includes("unknown subject") ||
    text.includes("not found")
  );
}

function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  createError: () => Error,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(createError()),
      Math.max(0, timeoutMs),
    );

    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export default StellarDIDCreditSDK;