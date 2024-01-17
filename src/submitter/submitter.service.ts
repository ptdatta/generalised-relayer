import { Injectable } from '@nestjs/common';
import { join } from 'path';
import { Worker } from 'worker_threads';
import { ChainConfig, ConfigService } from 'src/config/config.service';
import { LoggerService } from 'src/logger/logger.service';
import { LoggerOptions } from 'pino';

const RETRY_INTERVAL_DEFAULT = 2000;
const PROCESSING_INTERVAL_DEFAULT = 100;
const MAX_TRIES_DEFAULT = 3;
const MAX_PENDING_TRANSACTIONS = 1000;
const NEW_ORDERS_DELAY_DEFAULT = 0;
const TRANSACTION_TIMEOUT_DEFAULT = 10 * 60000;

interface GlobalSubmitterConfig {
  enabled: boolean;
  newOrdersDelay: number;
  retryInterval: number;
  processingInterval: number;
  maxTries: number;
  maxPendingTransactions: number;
  transactionTimeout: number;
  gasLimitBuffer: Record<string, number> & { default?: number }; //TODO 'gasLimitBuffer' should only be applied on a per-chain basis (like the other gas-related config)
}

export interface SubmitterWorkerData {
  chainId: string;
  rpc: string;
  relayerPrivateKey: string;
  incentivesAddresses: Map<string, string>;
  newOrdersDelay: number;
  retryInterval: number;
  processingInterval: number;
  maxTries: number;
  maxPendingTransactions: number;
  transactionTimeout: number;
  gasLimitBuffer: Record<string, number>;
  maxFeePerGas: number | undefined;
  maxPriorityFeeAdjustmentFactor: number | undefined;
  maxAllowedPriorityFeePerGas: number | undefined;
  gasPriceAdjustmentFactor: number | undefined;
  maxAllowedGasPrice: number | undefined;
  loggerOptions: LoggerOptions;
}

@Injectable()
export class SubmitterService {
  private readonly workers = new Map<string, Worker>();

  constructor(
    private readonly configService: ConfigService,
    private readonly loggerService: LoggerService,
  ) {}

  async onModuleInit(): Promise<void> {
    this.loggerService.info(`Starting the submitter on all chains...`);

    const globalSubmitterConfig = this.loadGlobalSubmitterConfig();

    // check if the submitter has been disabled.
    if (!globalSubmitterConfig.enabled) {
      this.loggerService.info(`Submitter has been disabled. Ending init early`);
      return;
    }

    // Initialize the submitter states
    for (const [, chainConfig] of this.configService.chainsConfig) {
      // Load the worker chain override config or set the defaults if missing
      const workerData = this.loadWorkerConfig(
        chainConfig,
        globalSubmitterConfig,
      );

      const worker = new Worker(join(__dirname, 'submitter.worker.js'), {
        workerData,
      });

      worker.on('error', (error) =>
        this.loggerService.fatal(
          error,
          `Error on submitter worker (chain ${chainConfig.chainId}).`,
        ),
      );

      worker.on('exit', (exitCode) =>
        this.loggerService.fatal(
          `Submitter worker exited with code ${exitCode} (chain ${chainConfig.chainId}).`,
        ),
      );

      this.workers.set(chainConfig.chainId, worker);
    }
  }

  private loadGlobalSubmitterConfig(): GlobalSubmitterConfig {
    const submitterConfig = this.configService.relayerConfig.submitter;

    const enabled = submitterConfig['enabled'] ?? true;

    const newOrdersDelay =
      submitterConfig.newOrdersDelay ?? NEW_ORDERS_DELAY_DEFAULT;
    const retryInterval =
      submitterConfig.retryInterval ?? RETRY_INTERVAL_DEFAULT;
    const processingInterval =
      submitterConfig.processingInterval ?? PROCESSING_INTERVAL_DEFAULT;
    const maxTries = submitterConfig.maxTries ?? MAX_TRIES_DEFAULT;
    const maxPendingTransactions =
      submitterConfig.maxPendingTransactions ?? MAX_PENDING_TRANSACTIONS;
    const transactionTimeout =
      submitterConfig.transactionTimeout ?? TRANSACTION_TIMEOUT_DEFAULT;

    const gasLimitBuffer = submitterConfig.gasLimitBuffer ?? {};
    if (!('default' in gasLimitBuffer)) {
      gasLimitBuffer['default'] = 0;
    }

    return {
      enabled,
      newOrdersDelay,
      retryInterval,
      processingInterval,
      maxTries,
      maxPendingTransactions,
      transactionTimeout,
      gasLimitBuffer,
    };
  }

  private loadWorkerConfig(
    chainConfig: ChainConfig,
    globalConfig: GlobalSubmitterConfig,
  ): SubmitterWorkerData {
    const chainId = chainConfig.chainId;
    const rpc = chainConfig.rpc;
    const relayerPrivateKey = this.configService.relayerConfig.privateKey;

    const incentivesAddresses = new Map<string, string>();
    this.configService.ambsConfig.forEach((amb) =>
      incentivesAddresses.set(
        amb.name,
        amb.getIncentivesAddress(chainConfig.chainId),
      ),
    );

    return {
      chainId,
      rpc,
      relayerPrivateKey,
      incentivesAddresses,

      newOrdersDelay:
        chainConfig.submitter.newOrdersDelay ?? globalConfig.newOrdersDelay,

      retryInterval:
        chainConfig.submitter.retryInterval ?? globalConfig.retryInterval,

      processingInterval:
        chainConfig.submitter.processingInterval ??
        globalConfig.processingInterval,

      maxTries: chainConfig.submitter.maxTries ?? globalConfig.maxTries,

      maxPendingTransactions:
        chainConfig.submitter.maxPendingTransactions ??
        globalConfig.maxPendingTransactions,

      transactionTimeout:
        chainConfig.submitter.transactionTimeout ??
        globalConfig.transactionTimeout,

      gasLimitBuffer: this.getChainGasLimitBufferConfig(
        globalConfig.gasLimitBuffer,
        chainConfig.submitter.gasLimitBuffer ?? {},
      ),

      maxFeePerGas: chainConfig.submitter.maxFeePerGas,

      maxPriorityFeeAdjustmentFactor:
        chainConfig.submitter.maxPriorityFeeAdjustmentFactor,

      maxAllowedPriorityFeePerGas:
        chainConfig.submitter.maxAllowedPriorityFeePerGas,

      gasPriceAdjustmentFactor: chainConfig.submitter.gasPriceAdjustmentFactor,

      maxAllowedGasPrice: chainConfig.submitter.maxAllowedGasPrice,

      loggerOptions: this.loggerService.loggerOptions,
    };
  }

  private getChainGasLimitBufferConfig(
    defaultGasLimitBufferConfig: Record<string, number>,
    chainGasLimitBufferConfig: Record<string, number>,
  ): Record<string, number> {
    const gasLimitBuffers: Record<string, number> = {};

    // Apply defaults
    for (const key in defaultGasLimitBufferConfig) {
      gasLimitBuffers[key] = defaultGasLimitBufferConfig[key];
    }

    // Apply chain overrides
    for (const key in chainGasLimitBufferConfig) {
      gasLimitBuffers[key] = chainGasLimitBufferConfig[key];
    }

    return gasLimitBuffers;
  }
}
