// Data layer of the extension's components/trade-panel.js. The DOM and the render loop are gone;
// what stays is the state machine — quote polling, derived CTA rules, submission and notices —
// which is where every trading rule in the extension lives.

import { ApiError, api, newClientRequestId } from '@/lib/api';
import { LIVE_PAINT_MS, PRICE_STALE_MS, QUOTE_REFRESH_MS } from '@/lib/config';
import { subscribeQuote } from '@/lib/market';
import { formatPrice, formatQty, formatUsd } from '@/lib/format';
import type { Asset, Position, Quote, Side } from '@/lib/types';
import { useApp } from '@/state/app';
import { useCallback, useEffect, useRef, useState } from 'react';
import { AppState } from 'react-native';

export interface Notice {
  kind: 'ok' | 'err' | 'loss';
  text: string;
}

export interface CtaState {
  label: string;
  ready: boolean;
  kind?: 'signin' | 'setup' | 'buy' | 'sell';
  pending?: boolean;
}

/** Cleans raw keystrokes the way the extension did: digits, one dot, two decimals, max 12 chars. */
export function sanitizeAmount(raw: string) {
  let v = raw.replace(/[^0-9.]/g, '');
  const firstDot = v.indexOf('.');
  if (firstDot !== -1) v = v.slice(0, firstDot + 1) + v.slice(firstDot + 1).replace(/\./g, '').slice(0, 2);
  return v.slice(0, 12);
}

/**
 * Re-prices an open position with a fresher quote — what the live feed paints between poll ticks,
 * so the position row, the sell CTA and the unrealized P&L move with the tape.
 */
function withLivePrice(position: Position, quote: Quote): Position {
  const marketValue = position.quantity * quote.priceUsd;
  const unrealizedPnl = marketValue - position.costBasis;
  return {
    ...position,
    currentPrice: quote.priceUsd,
    marketCapUsd: quote.marketCapUsd ?? position.marketCapUsd ?? null,
    marketValue,
    unrealizedPnl,
    unrealizedPnlPct: position.costBasis > 0 ? (unrealizedPnl / position.costBasis) * 100 : position.unrealizedPnlPct ?? null,
  };
}

export function useTrade(asset: Asset | null) {
  const {
    user,
    config,
    settings,
    account,
    needsSetup,
    serverError,
    portfolio,
    setServerError,
    loadPortfolio,
    loadAccount,
    signInWithGoogle,
    updateSettings,
  } = useApp();

  const [side, setSide] = useState<Side>('BUY');
  const [amount, setAmount] = useState('');
  const [sellPercent, setSellPercent] = useState<number | null>(null);
  const [quote, setQuote] = useState<Quote | null>(null);
  const [quoteReceivedAt, setQuoteReceivedAt] = useState(0);
  const [quoteError, setQuoteError] = useState<ApiError | null>(null);
  const [position, setPosition] = useState<Position | null>(null);
  const [pending, setPending] = useState(false);
  const [signingIn, setSigningIn] = useState(false);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [mismatchConfirmed, setMismatchConfirmed] = useState(false);
  const [editingPresets, setEditingPresets] = useState(false);
  // `Date.now()` can't be called while rendering, so a timer keeps this flag honest — the same
  // staleness check the extension ran at the end of every quote poll.
  const [isStale, setIsStale] = useState(false);

  const noticeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const alive = useRef(true);
  // Mirrors the selected token so an in-flight quote for the previous one can be dropped instead
  // of painting its price over the token the user just picked.
  const assetKeyRef = useRef('');
  // Same reason, for the whole asset object: the live subscription effect re-binds by key, not by
  // object identity.
  const assetRef = useRef<Asset | null>(null);

  useEffect(() => {
    assetKeyRef.current = asset ? `${asset.chain}:${asset.address}` : '';
    assetRef.current = asset;
  }, [asset]);

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
      if (noticeTimer.current) clearTimeout(noticeTimer.current);
    };
  }, []);

  useEffect(() => {
    const id = setInterval(() => {
      setIsStale(Boolean(quote) && Date.now() - quoteReceivedAt > PRICE_STALE_MS);
    }, 1000);
    return () => clearInterval(id);
  }, [quote, quoteReceivedAt]);

  const showNotice = useCallback((kind: Notice['kind'], text: string, ms = 5000) => {
    setNotice({ kind, text });
    if (noticeTimer.current) clearTimeout(noticeTimer.current);
    noticeTimer.current = setTimeout(() => {
      setNotice((n) => (n?.text === text ? null : n));
    }, ms);
  }, []);

  const clearNotice = useCallback(() => setNotice(null), []);

  // ---------- polling ----------
  // Self-scheduling rather than setInterval: a slow round trip delays the next tick instead of
  // stacking a second request on top of it, which is what made prices lag behind the chart.
  // This loop is now the supervisor: the live feed (below) does the painting, and the loop keeps
  // watching for a socket that died quietly (snapshot gone stale → the quote error surfaces).
  const refreshAsset = useCallback(async () => {
    if (!asset || !alive.current) return;
    const key = assetKeyRef.current;
    const stillCurrent = () => alive.current && assetKeyRef.current === key;
    try {
      if (user) {
        try {
          const res = await api.assetState(asset);
          if (!stillCurrent()) return;
          // `fetchedAt` identifies the WSS snapshot; if the live feed already painted it, skip the
          // identical state update instead of re-rendering the same price.
          setQuote((prev) => (prev?.fetchedAt === res.quote.fetchedAt ? prev : res.quote));
          setPosition(res.position);
          setQuoteError(null);
        } catch (err) {
          if (!(err instanceof ApiError) || err.code !== 'ACCOUNT_SETUP_REQUIRED') throw err;
          // Signed in but no starting capital chosen yet: still show the live price.
          void loadAccount();
          const res = await api.quote(asset);
          if (!stillCurrent()) return;
          setQuote((prev) => (prev?.fetchedAt === res.quote.fetchedAt ? prev : res.quote));
          setPosition(null);
          setQuoteError(null);
        }
      } else {
        const res = await api.quote(asset);
        if (!stillCurrent()) return;
        setQuote((prev) => (prev?.fetchedAt === res.quote.fetchedAt ? prev : res.quote));
        setQuoteError(null);
      }
      if (!stillCurrent()) return;
      setQuoteReceivedAt(Date.now());
    } catch (err) {
      if (!stillCurrent()) return;
      if (err instanceof ApiError) {
        if (err.code === 'SERVER_UNREACHABLE') setServerError(err);
        else setQuoteError(err);
      }
    }
  }, [asset, user, loadAccount, setServerError]);

  useEffect(() => {
    if (!asset) return;
    let timer: ReturnType<typeof setTimeout>;
    let live = true;

    const loop = async () => {
      if (!live) return;
      if (AppState.currentState === 'active') await refreshAsset();
      if (live) timer = setTimeout(loop, QUOTE_REFRESH_MS);
    };
    void loop();
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [asset, refreshAsset]);

  // ---------- live feed ----------
  // The socket pushes on every fill of the selected token; the panel repaints on each push
  // (batched inside LIVE_PAINT_MS) instead of waiting for the next poll tick. The open position is
  // re-priced locally with the same quote, so the sell-side CTA and the unrealized P&L follow the
  // tape too.
  const assetKey = asset ? `${asset.chain}:${asset.address}` : '';

  useEffect(() => {
    if (!assetKey || !assetRef.current) return;
    let pending: Quote | null = null;
    let timer: ReturnType<typeof setTimeout> | null = null;

    const paint = () => {
      timer = null;
      const quote = pending;
      if (!quote || !alive.current) return;
      pending = null;
      setQuote(quote);
      setQuoteReceivedAt(Date.now());
      setQuoteError(null);
      setPosition((prev) => (prev ? withLivePrice(prev, quote) : null));
    };

    const unsubscribe = subscribeQuote(assetRef.current, (quote) => {
      pending = quote;
      if (!timer) timer = setTimeout(paint, LIVE_PAINT_MS);
    });

    return () => {
      unsubscribe();
      if (timer) clearTimeout(timer);
    };
    // `assetKey` re-binds when the token changes; the asset object is read through assetRef so a
    // parent re-render with a new object identity never re-subscribes.
  }, [assetKey]);

  // ---------- derived ----------
  const symbol = quote?.symbol || asset?.symbol || 'token';
  const norm = (s?: string | null) => String(s ?? '').replace(/^\$/, '').toUpperCase();
  const symbolMismatch = Boolean(asset?.symbol && quote?.symbol && norm(asset.symbol) !== norm(quote.symbol));

  const amountNumber = () => {
    const n = Number(amount);
    return Number.isFinite(n) ? n : NaN;
  };

  const positionValue = () => (position && quote ? position.quantity * quote.priceUsd : 0);

  const presets = settings[side === 'BUY' ? 'buyPresets' : 'sellPresets'];

  /** The largest amount this side can actually submit. Buys: the percentage fee comes out of the
   *  amount, but the fixed network fee sits on top, so cash minus that fee is the ceiling. Sells:
   *  the whole position, never more than the configured per-trade cap. */
  const maxAmount = () => {
    if (side === 'SELL') return position ? positionValue() : 0;
    const cash = account?.cashBalance ?? portfolio?.account?.cashBalance ?? 0;
    const spendable = Math.max(0, cash - settings.networkFeeUsd);
    const cap = config?.maxTradeUsd ?? Infinity;
    return Math.min(spendable, cap);
  };

  /** Every disable rule for the primary button, ported 1:1 from ctaState(). */
  const ctaState = (): CtaState => {
    if (serverError) return { label: 'Paper server offline', ready: false };
    if (!asset) return { label: 'Select a token', ready: false };
    if (user && signingIn) return { label: 'Waiting for Google sign-in…', ready: false, pending: true };
    if (!user) return { label: 'Sign in with Google to paper trade', ready: true, kind: 'signin' };
    if (needsSetup) return { label: 'Choose your starting capital', ready: true, kind: 'setup' };
    if (pending) return { label: side === 'BUY' ? `Buying ${symbol}…` : `Selling ${symbol}…`, ready: false, pending: true };
    if (quoteError && !quote) return { label: 'Market price unavailable', ready: false };
    if (!quote) return { label: 'Loading price…', ready: false };
    if (isStale) return { label: 'Market data is stale', ready: false };

    const value = amountNumber();
    const base = side === 'BUY' ? `Buy ${symbol}` : `Sell ${symbol}`;
    if (side === 'SELL' && !position) return { label: `No ${symbol} to sell`, ready: false };
    if (!(value > 0) && !(side === 'SELL' && sellPercent)) return { label: base, ready: false };

    if (side === 'BUY') {
      const network = settings.networkFeeUsd;
      if (account && value + network > account.cashBalance + 1e-6) return { label: 'Not enough balance', ready: false };
      if (config?.minTradeUsd && value < config.minTradeUsd) return { label: `Minimum ${formatUsd(config.minTradeUsd)}`, ready: false };
      if (config?.maxTradeUsd && value > config.maxTradeUsd) {
        return { label: `Maximum ${formatUsd(config.maxTradeUsd, { decimals: 0 })}`, ready: false };
      }
    } else if (!sellPercent && value > positionValue() * 1.000001) {
      return { label: `Not enough ${symbol}`, ready: false };
    }
    if (symbolMismatch && !mismatchConfirmed) {
      return { label: `Confirm: trade ${quote.symbol}`, ready: true, kind: side.toLowerCase() as 'buy' | 'sell' };
    }
    return { label: base, ready: true, kind: side.toLowerCase() as 'buy' | 'sell' };
  };

  // ---------- actions ----------
  const setAmountFromInput = useCallback((raw: string) => {
    setAmount(sanitizeAmount(raw));
    setSellPercent(null);
    setMismatchConfirmed(false);
  }, []);

  const chooseSide = useCallback((next: Side) => {
    setSide(next);
    setAmount('');
    setSellPercent(null);
    setEditingPresets(false);
    setMismatchConfirmed(false);
  }, []);

  const applyPreset = useCallback(
    (index: number) => {
      const v = presets[index];
      if (v === undefined) return;
      if (side === 'BUY') {
        setAmount(String(v));
      } else if (position) {
        setSellPercent(v);
        setAmount((Math.floor(positionValue() * (v / 100) * 100) / 100).toFixed(2));
      }
      setMismatchConfirmed(false);
    },
    // positionValue reads position and quote, both listed here
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [presets, side, position, quote],
  );

  const applyMax = useCallback(() => {
    const value = Math.floor(maxAmount() * 100) / 100;
    if (!(value > 0)) return;
    setAmount(value.toFixed(2));
    setSellPercent(side === 'SELL' ? 100 : null);
    setMismatchConfirmed(false);
    // maxAmount reads account/portfolio/config/position/quote, all listed as deps
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [side, account, portfolio, config, position, quote]);

  const applyTradeResult = useCallback(
    (res: { position: Position | null; trade: { closesPosition?: boolean } }) => {
      setPosition(res.position);
      if (res.trade.closesPosition) void refreshAsset();
      void loadPortfolio();
    },
    [refreshAsset, loadPortfolio],
  );

  const signIn = useCallback(async () => {
    setSigningIn(true);
    try {
      await signInWithGoogle();
      showNotice('ok', 'Signed in.');
      void refreshAsset();
      void loadPortfolio();
    } catch (err) {
      if (err instanceof ApiError && err.code !== 'AUTH_CANCELLED') showNotice('err', err.message, 8000);
    } finally {
      setSigningIn(false);
    }
  }, [signInWithGoogle, showNotice, refreshAsset, loadPortfolio]);

  const submit = useCallback(async () => {
    const cta = ctaState();
    if (!cta.ready || !asset) return;
    if (cta.kind === 'signin') return void (await signIn());
    if (cta.kind === 'setup') {
      showNotice('ok', 'Choose your starting capital in Settings to begin.', 6000);
      return;
    }
    if (symbolMismatch && !mismatchConfirmed) {
      setMismatchConfirmed(true);
      return;
    }

    const body: { chain: string; address: string; side: Side; clientRequestId: string; amountUsd?: number; percent?: number } = {
      chain: asset.chain,
      address: asset.address,
      side,
      clientRequestId: newClientRequestId(),
    };
    if (side === 'SELL' && sellPercent) body.percent = sellPercent;
    else body.amountUsd = Math.round(amountNumber() * 100) / 100;

    setPending(true);
    try {
      const res = await api.trade(body);
      applyTradeResult(res);
      setAmount('');
      setSellPercent(null);
      const t = res.trade;
      const pnl = t.realizedPnl !== null && t.realizedPnl !== undefined ? ` · P&L ${formatUsd(t.realizedPnl, { sign: true })}` : '';
      showNotice(
        t.realizedPnl !== null && t.realizedPnl < 0 ? 'loss' : 'ok',
        `${t.side === 'BUY' ? 'Bought' : 'Sold'} ${formatQty(t.quantity)} ${t.symbol} at ${formatPrice(t.executionPrice)}${pnl}`,
      );
    } catch (err) {
      if (err instanceof ApiError) {
        showNotice('err', err.message, 7000);
        if (err.code.startsWith('MARKET_DATA')) void refreshAsset();
      }
    } finally {
      setPending(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [asset, side, sellPercent, amount, mismatchConfirmed, symbolMismatch, showNotice, refreshAsset, applyTradeResult, signIn]);

  const closePositionAction = useCallback(async () => {
    if (pending || !asset) return;
    setPending(true);
    try {
      const res = await api.closePosition({ chain: asset.chain, address: asset.address, clientRequestId: newClientRequestId() });
      applyTradeResult(res);
      showNotice(
        res.trade.realizedPnl !== null && res.trade.realizedPnl < 0 ? 'loss' : 'ok',
        `Position closed at ${formatPrice(res.trade.executionPrice)} · P&L ${formatUsd(res.trade.realizedPnl, { sign: true })}`,
      );
    } catch (err) {
      if (err instanceof ApiError) showNotice('err', err.message, 7000);
    } finally {
      setPending(false);
    }
  }, [pending, asset, applyTradeResult, showNotice]);

  const savePresets = useCallback(
    async (values: number[]) => {
      const valid = side === 'BUY' ? values.every((v) => v > 0 && v <= 1e6) : values.every((v) => v > 0 && v <= 100);
      if (!valid) {
        showNotice('err', side === 'BUY' ? 'Presets must be positive dollar amounts.' : 'Sell presets must be between 1 and 100%.');
        return false;
      }
      setEditingPresets(false);
      await updateSettings(side === 'BUY' ? { buyPresets: values } : { sellPresets: values });
      return true;
    },
    [side, showNotice, updateSettings],
  );

  return {
    side,
    amount,
    sellPercent,
    quote,
    quoteReceivedAt,
    quoteError,
    position,
    pending,
    signingIn,
    notice,
    mismatchConfirmed,
    editingPresets,
    presets,
    symbol,
    isStale,
    symbolMismatch,
    positionValue,
    maxAmount,
    ctaState,
    setAmount,
    setAmountFromInput,
    setSellPercent,
    chooseSide,
    applyPreset,
    applyMax,
    setEditingPresets,
    savePresets,
    refreshAsset,
    submit,
    closePosition: closePositionAction,
    showNotice,
    clearNotice,
  };
}
