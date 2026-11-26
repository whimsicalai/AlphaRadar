import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Interval } from '@nestjs/schedule';
import { Keypair, PublicKey, VersionedTransaction } from '@solana/web3.js';
import { Connection } from '@solana/web3.js';
import bs58 from 'bs58';
import { searcherClient, SearcherClient } from 'jito-ts/dist/sdk/block-engine/searcher';
import { Bundle } from 'jito-ts/dist/sdk/block-engine/types';

type BundleEntry = { sentAt: number; outcome?: 'landed' | 'failed' };

@Injectable()
export class JitoService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(JitoService.name);
  private client!: SearcherClient;
  private connection!: Connection;
  private authKeypair!: Keypair;
  private host!: string;
  private tipAccounts: string[] = [];
  private cancelResults: (() => void) | null = null;
  private readonly bundles = new Map<string, BundleEntry>();

  constructor(private readonly config: ConfigService) {}

  async onModuleInit() {
    const host = this.config.getOrThrow<string>('JITO_HOST');
    this.host = host;
    const secret = this.config.getOrThrow<string>('JITO_AUTH_KEY');
    this.authKeypair = Keypair.fromSecretKey(bs58.decode(secret));
    this.connection = new Connection(this.config.getOrThrow<string>('SOLANA_RPC_URL'), 'confirmed');
    this.client = searcherClient(host, this.authKeypair);

    const res = await this.client.getTipAccounts();
    if (!res.ok) {
      throw res.error;
    }
    this.tipAccounts = res.value;

    this.cancelResults = this.client.onBundleResult(
      (result) => {
        const entry = this.bundles.get(result.bundleId);
        if (!entry) return;
        if (result.processed || result.finalized) {
          entry.outcome = 'landed';
        } else if (result.rejected || result.dropped) {
          entry.outcome = 'failed';
        }
      },
      (err) => this.logger.error(`subscription to ${this.host} lost: ${err.message}`),
    );
    this.logger.log(`connected to ${host}, ${this.tipAccounts.length} tip accounts`);
  }

  onModuleDestroy() {
    if (this.cancelResults) {
      this.cancelResults();
    }
  }

  async submit(txs: VersionedTransaction[], tipLamports: number): Promise<string> {
    if (this.tipAccounts.length === 0) {
      throw new Error('getTipAccounts returned empty list');
    }
    const tipTo = new PublicKey(this.tipAccounts[Math.floor(Math.random() * this.tipAccounts.length)]);
    const { blockhash } = await this.connection.getLatestBlockhash('finalized');

    const bundle = new Bundle(txs, 5);
    const sealed = bundle.addTipTx(this.authKeypair, tipLamports, tipTo, blockhash);
    if (sealed instanceof Error) {
      throw sealed;
    }

    const res = await this.client.sendBundle(sealed);
    if (!res.ok) {
      throw res.error;
    }
    const bundleId = res.value;
    this.bundles.set(bundleId, { sentAt: Date.now() });
    return bundleId;
  }

  @Interval(60_000)
  logLandRate() {
    const cutoff = Date.now() - 60_000;
    let recentLanded = 0;
    let recentTotal = 0;
    for (const entry of this.bundles.values()) {
      if (entry.sentAt >= cutoff) {
        recentTotal++;
        if (entry.outcome === 'landed') recentLanded++;
      }
    }
    const staleBefore = Date.now() - 10 * 60_000;
    for (const [id, entry] of this.bundles) {
      if (entry.sentAt < staleBefore) {
        if (!entry.outcome) {
          entry.outcome = 'failed';
        }
        if (this.bundles.size > 5000) {
          this.bundles.delete(id);
        }
      }
    }
    const all = this.stats();
    const recentRate = recentTotal ? ((recentLanded / recentTotal) * 100).toFixed(1) : 'n/a';
    this.logger.log(
      `land rate last minute: ${recentRate}% (${recentLanded}/${recentTotal}), lifetime: ${all.landRate.toFixed(1)}% (${all.landed}/${all.total})`,
    );
  }

  stats() {
    let landed = 0;
    let failed = 0;
    for (const entry of this.bundles.values()) {
      if (entry.outcome === 'landed') landed++;
      else if (entry.outcome === 'failed') failed++;
    }
    const total = this.bundles.size;
    return {
      total,
      landed,
      failed,
      pending: total - landed - failed,
      landRate: total ? (landed / total) * 100 : 0,
    };
  }
}
