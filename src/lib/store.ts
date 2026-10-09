/**
 * Local store — the app's single source of truth now that there is no backend. Everything the old
 * server kept in its database lives here in one AsyncStorage record: the local user, the paper
 * account, positions, trades, closed trades, consent, per-asset market memory (last known price,
 * so positions keep a value while the feed is quiet), and the idempotency map for `clientRequestId`
 * (a retried tap must not double-fill).
 *
 * Writes go through a serial queue: React Native runs this single-threaded, but concurrent
 * read-modify-write cycles (a trade landing while the portfolio polls) would otherwise interleave.
 */

import AsyncStorage from '@react-native-async-storage/async-storage';

import { bumpPortfolioVersion, clearSession, getSettings, setSession } from './storage';
import { ApiError } from './errors';
import { newId } from './ids';
import { PAPER_CONFIG, effectiveConfig, slippageRateOf } from './engine/rules';
import {
  assetIdOf,
  closePositionTrade,
  executeTrade,
  marketInputFromQuote,
  toPosition,
  type EngineState,
  type StoredAccount,
  type StoredPosition,
} from './engine/trades';
import { computePortfolio, filterTrades, sortTradesNewestFirst, startOfLocalDay, type PriceResolver } from './engine/portfolio';
import { computeTradingStyle } from './engine/style';
import { fetchQuote, readQuote } from './market';
import type { Account, Asset, ClosedTrade, Me, Position, Portfolio, Quote, ServerConfig, SessionUser, Trade } from './types';

const STORAGE_KEY = 'paper.local.v1';

export interface AssetMeta {
  symbol?: string | null;
  name?: string | null;
  imageUrl?: string | null;
  lastPriceUsd?: number | null;
  lastMarketCapUsd?: number | null;
  lastLiquidityUsd?: number | null;
  updatedAt?: string;
}

export interface ConsentRecord {
  acceptedTerms: boolean;
  confirmedAge: boolean;
  policyVersion: string;
  acceptedAt: string;
}

export interface LocalData {
  user: SessionUser | null;
  account: StoredAccount | null;
  positions: StoredPosition[];
  trades: Trade[];
  closed: ClosedTrade[];
  consent: ConsentRecord | null;
  /** Market memory per "chain:address", so positions stay valued while Azura is quiet. */
  assets: Record<string, AssetMeta>;
  /** clientRequestId → the exact response it produced (retry-safe). */
  requests: Record<string, { position: Position | null; trade: Trade }>;
}

const EMPTY: LocalData = {
  user: null,
  account: null,
  positions: [],
  trades: [],
  closed: [],
  consent: null,
  assets: {},
  requests: {},
};

// ─── serialization ──────────────────────────────────────────────────────────

async function read(): Promise<LocalData> {
  try {
    const raw = await AsyncStorage.getItem(STORAGE_KEY);
    if (!raw) return { ...EMPTY };
    const parsed = JSON.parse(raw) as Partial<LocalData>;
    return { ...EMPTY, ...parsed, assets: parsed.assets ?? {}, requests: parsed.requests ?? {} };
  } catch {
    return { ...EMPTY };
  }
}

async function write(data: LocalData): Promise<void> {
  try {
    await AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(data));
  } catch {
    // A failed write must not break the flow; the next successful one persists the newer state.
  }
}

let queue: Promise<unknown> = Promise.resolve();

/** Serialized read-modify-write. `mutator` returns the new snapshot plus the value to hand back. */
function update<T>(mutator: (data: LocalData) => { data: LocalData; result: T } | Promise<{ data: LocalData; result: T }>): Promise<T> {
  const run = (queue = queue.then(async () => {
    const current = await read();
    const { data, result } = await mutator(current);
    await write(data);
    return result;
  }));
  return run as Promise<T>;
}

// ─── market memory ──────────────────────────────────────────────────────────

/** `ClosedTrade.exitTime` is optional in the shared types; treat a missing stamp as epoch 0. */
const ms = (v?: string) => (v ? new Date(v).getTime() : 0);

function rememberAsset(data: LocalData, asset: Asset, from: Quote): void {
  const id = assetIdOf(asset.chain, asset.address);
  const prev = data.assets[id] ?? {};
  data.assets[id] = {
    ...prev,
    symbol: from.symbol ?? prev.symbol ?? null,
    name: from.name ?? prev.name ?? null,
    imageUrl: from.imageUrl ?? prev.imageUrl ?? null,
    lastPriceUsd: from.priceUsd > 0 ? from.priceUsd : prev.lastPriceUsd ?? null,
    lastMarketCapUsd: from.marketCapUsd ?? prev.lastMarketCapUsd ?? null,
    lastLiquidityUsd: from.liquidityUsd ?? prev.lastLiquidityUsd ?? null,
    updatedAt: new Date().toISOString(),
  };
}

/**
 * Positions are priced with a live quote when the feed has one, else the remembered price, so a
 * quiet socket never zeroes the portfolio's value.
 */
function resolverFrom(assets: Record<string, AssetMeta>): PriceResolver {
  return (assetId) => {
    const [chain, address] = assetId.split(':');
    const live = chain && address ? readQuote(chain, address) : null;
    const meta = assets[assetId];
    return {
      priceUsd: live?.priceUsd ?? meta?.lastPriceUsd ?? null,
      marketCapUsd: live?.marketCapUsd ?? meta?.lastMarketCapUsd ?? null,
      symbol: live?.symbol ?? meta?.symbol ?? null,
    };
  };
}

function positionFrom(p: StoredPosition, quote: Quote): Position {
  return toPosition(p, quote.priceUsd, quote.marketCapUsd ?? null, quote.symbol ?? null);
}

/**
 * The engine's rules with the user's editable values (Settings → slippage tolerances, network fee)
 * layered over the built-in defaults. Read fresh per order so a change takes effect immediately.
 */
async function cfgFromSettings(): Promise<PaperConfigLite> {
  const s = await getSettings();
  return effectiveConfig({
    slippageBuyPct: s.slippageBuyPct,
    slippageSellPct: s.slippageSellPct,
    networkFeeUsd: s.networkFeeUsd,
  });
}

type PaperConfigLite = import('./engine/rules').PaperConfig;

// ─── public API used by `api.ts` ────────────────────────────────────────────

export const store = {
  /** Config the screens read once at boot. */
  config(): ServerConfig {
    return {
      paperMode: PAPER_CONFIG.paperMode,
      devAuth: PAPER_CONFIG.devAuth,
      startingBalance: PAPER_CONFIG.startingBalance,
      minStartingBalance: PAPER_CONFIG.minStartingBalance,
      maxStartingBalance: PAPER_CONFIG.maxStartingBalance,
      startingBalancePresets: PAPER_CONFIG.startingBalancePresets,
      feeRate: PAPER_CONFIG.feeRate,
      slippageRate: slippageRateOf(PAPER_CONFIG),
      slippageBuyPct: PAPER_CONFIG.slippageBuyPct,
      slippageSellPct: PAPER_CONFIG.slippageSellPct,
      slippageCapPct: PAPER_CONFIG.slippageCapPct,
      fallbackSlippagePct: PAPER_CONFIG.fallbackSlippagePct,
      networkFeeUsd: PAPER_CONFIG.networkFeeUsd,
      minTradeUsd: PAPER_CONFIG.minTradeUsd,
      maxTradeUsd: PAPER_CONFIG.maxTradeUsd,
      minimumAge: PAPER_CONFIG.minimumAge,
      policyVersion: PAPER_CONFIG.policyVersion,
      marketDataProvider: PAPER_CONFIG.marketDataProvider,
    };
  },

  async me(): Promise<Me> {
    const data = await read();
    return {
      user: data.user,
      account: data.account ? { cashBalance: data.account.cashBalance, startingBalance: data.account.startingBalance } : null,
      needsSetup: data.account == null,
      needsConsent: data.consent == null,
    };
  },

  /** Developer sign-in: a local identity keyed by email. No password, no server. */
  async devSignIn(email: string, name?: string): Promise<SessionUser> {
    const trimmed = email.trim().toLowerCase();
    const user: SessionUser = {
      email: trimmed,
      displayName: name?.trim() || trimmed.split('@')[0],
      photoUrl: null,
    };
    await update((data) => ({ data: { ...data, user }, result: user }));
    await setSession({ token: `local_${newId('u')}`, user });
    return user;
  },

  /** Google sign-in result: the profile comes from Google's userinfo, identity stays local. */
  async googleSignIn(profile: SessionUser): Promise<SessionUser> {
    const email = profile.email?.toLowerCase() ?? 'trader@local';
    const user: SessionUser = {
      email,
      displayName: profile.displayName ?? email.split('@')[0],
      photoUrl: profile.photoUrl ?? null,
    };
    await update((data) => ({ data: { ...data, user }, result: user }));
    await setSession({ token: `local_${newId('u')}`, user });
    return user;
  },

  async signOut(): Promise<void> {
    await clearSession();
  },

  async updateProfile(patch: { displayName?: string; photoUrl?: string | null }): Promise<SessionUser> {
    return update((data) => {
      const base = data.user ?? { email: 'trader@local', displayName: 'Paper trader' };
      const user: SessionUser = { ...base, ...patch };
      void setSession({ token: `local_${user.email ?? 'anon'}`, user });
      return { data: { ...data, user }, result: user };
    });
  },

  async consent(body: { acceptedTerms?: boolean; confirmedAge?: boolean }): Promise<void> {
    if (!body.acceptedTerms || !body.confirmedAge) {
      throw new ApiError(400, 'CONSENT_INCOMPLETE', 'You must accept the terms and confirm your age.');
    }
    await update((data) => ({
      data: {
        ...data,
        consent: {
          acceptedTerms: true,
          confirmedAge: true,
          policyVersion: PAPER_CONFIG.policyVersion,
          acceptedAt: new Date().toISOString(),
        },
      },
      result: undefined,
    }));
  },

  async startAccount(startingBalance: number): Promise<Account> {
    if (!Number.isFinite(startingBalance) || startingBalance < PAPER_CONFIG.minStartingBalance || startingBalance > PAPER_CONFIG.maxStartingBalance) {
      throw new ApiError(400, 'INVALID_STARTING_BALANCE', `Starting capital must be between $${PAPER_CONFIG.minStartingBalance} and $${PAPER_CONFIG.maxStartingBalance}.`);
    }
    return update((data) => {
      if (data.account) {
        throw new ApiError(400, 'ACCOUNT_ALREADY_STARTED', 'Your paper account already exists — use Reset to start over.');
      }
      const account: StoredAccount = { cashBalance: startingBalance, startingBalance, startedAt: new Date().toISOString() };
      return { data: { ...data, account }, result: { cashBalance: account.cashBalance, startingBalance: account.startingBalance } };
    });
  },

  async resetAccount(startingBalance: number): Promise<Account> {
    if (!Number.isFinite(startingBalance) || startingBalance < PAPER_CONFIG.minStartingBalance || startingBalance > PAPER_CONFIG.maxStartingBalance) {
      throw new ApiError(400, 'INVALID_STARTING_BALANCE', `Starting capital must be between $${PAPER_CONFIG.minStartingBalance} and $${PAPER_CONFIG.maxStartingBalance}.`);
    }
    const result = await update((data) => {
      const account: StoredAccount = { cashBalance: startingBalance, startingBalance, startedAt: new Date().toISOString() };
      return {
        data: { ...data, account, positions: [], trades: [], closed: [], requests: {} },
        result: { cashBalance: account.cashBalance, startingBalance: account.startingBalance },
      };
    });
    await bumpPortfolioVersion();
    return result;
  },

  async deleteAccount(): Promise<void> {
    await update(() => ({ data: { ...EMPTY }, result: undefined }));
    await clearSession();
    await bumpPortfolioVersion();
  },

  async portfolio(tzOffsetMinutes: number): Promise<Portfolio> {
    const data = await read();
    if (!data.account) throw new ApiError(400, 'ACCOUNT_SETUP_REQUIRED', 'Choose your starting capital first.');
    const state: EngineState = {
      account: data.account,
      positions: data.positions,
      trades: data.trades,
      closed: data.closed,
    };
    const portfolio = computePortfolio({ state, prices: resolverFrom(data.assets), tzOffsetMinutes });
    return { ...portfolio, tradingStyle: computeTradingStyle(state) };
  },

  /** Quote + the caller's position (null when they have none, or no account yet). */
  async assetState(asset: Asset): Promise<{ quote: Quote; position: Position | null }> {
    const data = await read();
    const quote = await fetchQuote(asset);
    rememberAsset(data, asset, quote);
    await write(data);
    if (!data.account) return { quote, position: null };
    const stored = data.positions.find((p) => p.assetId === assetIdOf(asset.chain, asset.address)) ?? null;
    return { quote, position: stored ? positionFrom(stored, quote) : null };
  },

  async trades(side?: 'BUY' | 'SELL' | ''): Promise<Trade[]> {
    const data = await read();
    return filterTrades(sortTradesNewestFirst(data.trades), side);
  },

  async closedTrades(): Promise<ClosedTrade[]> {
    const data = await read();
    return [...data.closed].sort((a, b) => ms(b.exitTime) - ms(a.exitTime));
  },

  async exportData(): Promise<{ account: Account | null; trades: Trade[]; closed: ClosedTrade[] }> {
    const data = await read();
    return {
      account: data.account ? { cashBalance: data.account.cashBalance, startingBalance: data.account.startingBalance } : null,
      trades: sortTradesNewestFirst(data.trades),
      closed: [...data.closed].sort((a, b) => ms(b.exitTime) - ms(a.exitTime)),
    };
  },

  /** Logo URL Azura last reported for a token (no HTTP fetch of our own). */
  async logo(asset: Asset): Promise<string | null> {
    const live = readQuote(asset.chain, asset.address);
    if (live?.imageUrl) return live.imageUrl;
    const data = await read();
    return data.assets[assetIdOf(asset.chain, asset.address)]?.imageUrl ?? null;
  },

  /**
   * One market order. Idempotent on `clientRequestId`: a retry with the same key returns the very
   * same response without touching balances (the old server did this with a unique constraint).
   */
  async executeOrder(input: {
    chain: string;
    address: string;
    side: 'BUY' | 'SELL';
    clientRequestId: string;
    amountUsd?: number;
    percent?: number;
  }): Promise<{ position: Position | null; trade: Trade }> {
    const result = await update(async (data) => {
      const cached = data.requests[input.clientRequestId];
      if (cached) return { data, result: cached };

      const asset: Asset = { chain: input.chain, address: input.address, symbol: null };
      const quote = await fetchQuote(asset);
      rememberAsset(data, asset, quote);

      const state: EngineState = {
        account: data.account,
        positions: data.positions,
        trades: data.trades,
        closed: data.closed,
      };
      const outcome = executeTrade(
        state,
        {
          chain: input.chain,
          address: input.address,
          side: input.side,
          clientRequestId: input.clientRequestId,
          amountUsd: input.amountUsd,
          percent: input.percent,
          market: marketInputFromQuote(quote),
        },
        await cfgFromSettings(),
      );

      const requests = { ...data.requests, [input.clientRequestId]: { position: outcome.position, trade: outcome.trade } };
      return { data: { ...data, ...outcome.state, requests }, result: { position: outcome.position, trade: outcome.trade } };
    });
    await bumpPortfolioVersion();
    return result;
  },

  async closePosition(chain: string, address: string, clientRequestId: string): Promise<{ position: Position | null; trade: Trade }> {
    const result = await update(async (data) => {
      const cached = data.requests[clientRequestId];
      if (cached) return { data, result: cached };

      const asset: Asset = { chain, address, symbol: null };
      const quote = await fetchQuote(asset);
      rememberAsset(data, asset, quote);

      const state: EngineState = {
        account: data.account,
        positions: data.positions,
        trades: data.trades,
        closed: data.closed,
      };
      const outcome = closePositionTrade(
        state,
        {
          chain,
          address,
          clientRequestId,
          market: marketInputFromQuote(quote),
        },
        await cfgFromSettings(),
      );

      const requests = { ...data.requests, [clientRequestId]: { position: outcome.position, trade: outcome.trade } };
      return { data: { ...data, ...outcome.state, requests }, result: { position: outcome.position, trade: outcome.trade } };
    });
    await bumpPortfolioVersion();
    return result;
  },
};

/** Local-midnight epoch ms for the device's UTC offset (Date.getTimezoneOffset semantics). */
export const todayStart = startOfLocalDay;
