// Port of the extension's components/trade-panel.js: Buy/Sell tabs, amount, presets, available
// balance, the primary action, the simulation status row and the open position card. The DOM
// listeners are gone — the rules they guarded live in useTrade — and this file is the view.

import { useState } from 'react';
import { Pressable, Share, StyleSheet, Text, View } from 'react-native';

import { GoogleIcon, Icon } from '@/components/icons';
import { TokenAvatar } from '@/components/token-avatar';
import { AmountField, Banner, Btn, Card, DetailRow, SegTabs, StatusRow } from '@/components/ui';
import { Palette, Radius } from '@/constants/paper';
import { LOW_LIQUIDITY_USD } from '@/lib/config';
import { marketInputFromQuote, previewOrder } from '@/lib/engine/trades';
import { effectiveConfig } from '@/lib/engine/rules';
import {
  arrow,
  formatCompactUsd,
  formatPct,
  formatPrice,
  formatQty,
  formatUsd,
  pnlClass,
  timeAgo,
} from '@/lib/format';
import type { Asset } from '@/lib/types';
import { useApp } from '@/state/app';
import { useTrade } from '@/state/use-trade';

/** A price level shown as USD per token, or as market cap when the user prefers MC. */
const levelFormatter = (priceDisplay: 'price' | 'mcap') => ({
  level: (price?: number | null, marketCap?: number | null) =>
    priceDisplay === 'mcap' && (marketCap ?? 0) > 0 ? `${formatCompactUsd(marketCap)} MC` : formatPrice(price),
  label: (word: string) => (priceDisplay === 'mcap' ? `${word} MC` : `${word} price`),
});

export function TradePanel({ asset }: { asset: Asset | null }) {
  const { user, config, account, needsSetup, portfolio, settings, serverError } = useApp();
  const trade = useTrade(asset);
  const [statusOpen, setStatusOpen] = useState(false);
  const [draft, setDraft] = useState<string[]>([]);

  const quote = trade.quote;
  const sym = trade.symbol;
  const side = trade.side;
  const priceDisplay = settings.priceDisplay;
  const level = levelFormatter(priceDisplay);
  const amountNum = Number(trade.amount);
  const presetValues = trade.presets;

  /** The editor opens with the current presets typed in, as the extension did on focus. */
  const openEditor = () => {
    setDraft(presetValues.map((v) => String(v)));
    trade.setEditingPresets(true);
  };

  // The "you receive" estimate runs the same constant-product math the engine applies on submit,
  // so what the panel promises is what the fill delivers — using the user's own tolerances.
  const tradeCfg = effectiveConfig({
    slippageBuyPct: settings.slippageBuyPct,
    slippageSellPct: settings.slippageSellPct,
    networkFeeUsd: settings.networkFeeUsd,
  });
  const preview =
    quote && (amountNum > 0 || (side === 'SELL' && trade.sellPercent))
      ? previewOrder(
          {
            side,
            amountUsd: amountNum > 0 ? amountNum : undefined,
            percent: side === 'SELL' && trade.sellPercent ? trade.sellPercent : undefined,
            positionQuantity: trade.position?.quantity,
            market: marketInputFromQuote(quote),
          },
          tradeCfg,
        )
      : null;
  const hint = preview
    ? `≈ ${formatQty(preview.quantity)} ${sym}${preview.impactPct >= 1 ? ` · ${formatPct(preview.impactPct, { sign: false })} impact` : ''}${
        preview.revertsAlways ? ' · always reverts' : preview.revertRiskPct >= 25 ? ` · ${Math.round(preview.revertRiskPct)}% revert risk` : ''
      }`
    : side === 'SELL' && trade.sellPercent
      ? `${trade.sellPercent}% of position`
      : 'Enter amount';

  // Available balance: cash for buys, the whole position for sells.
  const available = (() => {
    if (!user) return 'Sign in, then choose your starting capital';
    if (needsSetup) return 'Choose how much virtual capital to practice with';
    if (side === 'BUY') {
      const cash = account?.cashBalance ?? portfolio?.account?.cashBalance ?? portfolio?.performance?.cash;
      return cash === undefined || cash === null ? '' : `${formatUsd(cash)} available`;
    }
    return trade.position
      ? `${formatQty(trade.position.quantity)} ${sym} · ${formatUsd(trade.positionValue())} available`
      : `0 ${sym} available`;
  })();

  const stale = trade.isStale;
  const status = (() => {
    if (serverError) return { danger: true, text: 'Paper server offline' };
    if (!asset) return { danger: false, text: 'Paper trading · no token selected' };
    if (trade.quoteError && !quote)
      return {
        danger: true,
        text: trade.quoteError.code === 'ASSET_NOT_FOUND' ? 'No market found for this token' : 'Market price unavailable',
      };
    if (stale) return { danger: true, text: 'Market data is stale · refresh' };
    if (trade.symbolMismatch && asset.symbol && quote?.symbol)
      return { danger: true, text: `Check token: page shows ${asset.symbol}, market is ${quote.symbol}` };
    if (quote) {
      // The header reads symbol · market cap — the price lives in the levels below, where
      // the user toggles price/MC display anyway. A missing MC falls back to the bare symbol.
      const mc = quote.marketCapUsd;
      return { danger: false, text: mc ? `${sym} · ${formatCompactUsd(mc)} MC` : sym };
    }
    return { danger: false, text: `Loading ${sym} price…` };
  })();

  const cta = trade.ctaState();
  const ctaVariant = cta.kind === 'buy' ? 'buy' : cta.kind === 'sell' ? 'sell' : 'setup';
  const max = trade.maxAmount();

  const sharePosition = async () => {
    const p = trade.position;
    if (!p) return;
    const pct = p.unrealizedPnlPct ?? 0;
    await Share.share({
      message: [
        `${sym} paper position`,
        `P&L ${formatUsd(p.unrealizedPnl, { sign: true })} (${formatPct(Math.abs(pct), { sign: false })})`,
        `Invested ${formatUsd(p.costBasis)} · avg entry ${level.level(p.averageEntryPrice, p.entryMarketCapUsd)}`,
        `Now ${level.level(p.currentPrice, p.marketCapUsd)} · Simulated fills at live prices · no real funds`,
      ].join('\n'),
    });
  };

  const position = trade.position;
  const showPosition = Boolean(position && user && !needsSetup);

  return (
    <View style={styles.wrap}>
      <Card style={styles.card}>
        <SegTabs
          accent={side === 'BUY' ? 'buy' : 'sell'}
          value={side}
          onChange={(next) => trade.chooseSide(next)}
          options={[
            { value: 'BUY', label: 'Buy' },
            { value: 'SELL', label: 'Sell' },
          ]}
          style={{ alignSelf: 'stretch' }}
        />

        <AmountField value={trade.amount} onChange={trade.setAmountFromInput} hint={hint} onSubmit={trade.submit} />

        {trade.editingPresets ? (
          <View style={styles.editor}>
            {draft.map((v, i) => (
              <AmountField
                key={i}
                value={v}
                onChange={(next) => setDraft((d) => d.map((x, j) => (j === i ? next : x)))}
                hint={`Preset ${i + 1}`}
              />
            ))}
            <View style={styles.editorRow}>
              <Text style={styles.muted}>{side === 'BUY' ? 'Buy presets ($)' : 'Sell presets (%)'}</Text>
              <View style={{ flex: 1 }} />
              <Btn label="Cancel" variant="sm" onPress={() => trade.setEditingPresets(false)} />
              <Btn
                label="Save"
                variant="sm"
                onPress={() =>
                  void trade.savePresets(draft.map((v) => Number(v)))
                }
              />
            </View>
          </View>
        ) : (
          <View style={styles.presets}>
            {presetValues.map((v, i) => {
              const disabled = side === 'SELL' && !trade.position;
              const active = side === 'SELL' ? trade.sellPercent === v : amountNum === v;
              return (
                <Pressable
                  key={i}
                  accessibilityRole="button"
                  disabled={disabled}
                  onPress={() => trade.applyPreset(i)}
                  style={[styles.preset, active && styles.presetActive, disabled && styles.presetDisabled]}>
                  <Text style={[styles.presetLabel, active && { color: Palette.textPrimary }]}>
                    {side === 'BUY' ? formatUsd(v, { decimals: 0 }) : `${v}%`}
                  </Text>
                </Pressable>
              );
            })}
            <Pressable
              accessibilityRole="button"
              disabled={!(max > 0)}
              onPress={trade.applyMax}
              style={[
                styles.preset,
                max > 0 && Math.abs(amountNum - Math.floor(max * 100) / 100) < 0.005 && styles.presetActive,
                !(max > 0) && styles.presetDisabled,
              ]}>
              <Text style={[styles.presetLabel, styles.maxLabel]}>Max</Text>
            </Pressable>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Edit presets"
              onPress={openEditor}
              style={[styles.preset, styles.gear]}>
              <Icon name="gear" size={15} color={Palette.textSecondary} />
            </Pressable>
          </View>
        )}

        <Text style={styles.available}>{available}</Text>

        <Btn
          label={cta.label}
          variant={ctaVariant}
          disabled={!cta.ready}
          busy={cta.pending}
          left={cta.kind === 'signin' ? <GoogleIcon size={17} /> : undefined}
          right={cta.kind === 'signin' ? undefined : <Text style={styles.tag}>PAPER</Text>}
          onPress={trade.submit}
        />

        {trade.notice ? <Banner kind={trade.notice.kind}>{trade.notice.text}</Banner> : null}

        <StatusRow
          text={status.text}
          danger={status.danger}
          expandable
          expanded={statusOpen}
          onToggle={() => {
            if (!statusOpen && (stale || trade.quoteError || serverError)) void trade.refreshAsset();
            setStatusOpen((v) => !v);
          }}
          icon={
            status.danger ? (
              <Icon name="warning" size={16} color={Palette.red} />
            ) : (
              <Icon name="paper" size={16} color={Palette.paper} />
            )
          }>
          <View style={styles.statusBody}>
            {serverError ? (
              <Text style={styles.statusPara}>{serverError.message}</Text>
            ) : trade.quoteError && !quote ? (
              <Text style={styles.statusPara}>{trade.quoteError.message} Paper trades can&apos;t be placed until a current price is available.</Text>
            ) : null}
            {quote ? (
              <>
                <DetailRow label="Simulated execution price" value={preview ? formatPrice(preview.execPriceUsd) : formatPrice(quote.priceUsd)} />
                <DetailRow label="Market price" value={formatPrice(quote.priceUsd)} />
                {preview && preview.poolKnown && preview.impactPct >= 0.5 ? (
                  <DetailRow
                    label="Price impact"
                    value={formatPct(preview.impactPct, { sign: false })}
                    color={preview.impactPct >= 5 ? Palette.red : undefined}
                  />
                ) : null}
                {preview?.revertsAlways ? (
                  <Text style={styles.statusPara}>
                    This order is bigger than your {formatPct(side === 'BUY' ? settings.slippageBuyPct : settings.slippageSellPct, { sign: false })}{' '}
                    {side.toLowerCase()} slippage allows — it would revert instead of filling.
                  </Text>
                ) : null}
                {preview && !preview.poolKnown ? (
                  <Text style={styles.statusPara}>
                    Pool liquidity unknown — a {formatPct(config?.fallbackSlippagePct ?? 1.5, { sign: false })} fallback slippage stands in.
                  </Text>
                ) : null}
                <DetailRow
                  label="Liquidity"
                  value={formatCompactUsd(quote.liquidityUsd)}
                  color={quote.liquidityUsd != null && quote.liquidityUsd < LOW_LIQUIDITY_USD ? Palette.red : undefined}
                />
                <DetailRow label="Market cap" value={formatCompactUsd(quote.marketCapUsd)} />
                <DetailRow
                  label="24h"
                  value={formatPct(quote.change24hPct)}
                  color={quote.change24hPct && quote.change24hPct > 0 ? Palette.green : quote.change24hPct && quote.change24hPct < 0 ? Palette.red : undefined}
                />
                <DetailRow
                  label="Simulated fee"
                  value={`${formatPct((quote.feeRate ?? config?.feeRate ?? 0) * 100, { sign: false })} + ${formatUsd(settings.networkFeeUsd)}`}
                />
                <DetailRow
                  label="Simulated slippage"
                  value={formatPct(side === 'BUY' ? settings.slippageBuyPct : settings.slippageSellPct, { sign: false })}
                />
                <DetailRow label="Price source" value={`${quote.dex ?? quote.source ?? 'market'} · ${timeAgo(new Date(trade.quoteReceivedAt).toISOString())}`} />
              </>
            ) : null}
            {stale ? <Text style={styles.statusPara}>Market data is stale. Refresh before placing a paper trade.</Text> : null}
            {trade.symbolMismatch ? (
              <Text style={styles.statusPara}>
                The ticker doesn&apos;t match the market data for this address. Make sure you&apos;re trading the token you expect.
              </Text>
            ) : null}
            <Text style={styles.statusPara}>Trades here are simulated. No wallet is connected and no real order is sent.</Text>
          </View>
        </StatusRow>
      </Card>

      {showPosition && position ? (
        <Card
          style={styles.card}
          tone={position.unrealizedPnl > 0 ? 'profit' : position.unrealizedPnl < 0 ? 'loss' : undefined}>
          <View style={styles.posHead}>
            <TokenAvatar symbol={sym} chainId={position.chainId} address={position.address} tone={pnlClass(position.unrealizedPnl) ? (position.unrealizedPnl > 0 ? 'profit' : 'loss') : ''} />
            <View style={styles.posLead}>
              <Text style={styles.posLevel}>{level.level(position.currentPrice, position.marketCapUsd)}</Text>
              <Text style={styles.posSub}>
                {formatQty(position.quantity)} {sym}
              </Text>
            </View>
            <View style={styles.posPnl}>
              <Text style={[styles.posPnlMain, { color: pnlClass(position.unrealizedPnl) === 'up' ? Palette.green : pnlClass(position.unrealizedPnl) === 'down' ? Palette.red : Palette.textPrimary }]}>
                {formatUsd(position.unrealizedPnl, { sign: true })}
              </Text>
              <Text style={[styles.posPnlSub, { color: pnlClass(position.unrealizedPnl) === 'up' ? Palette.green : Palette.red }]}>
                {arrow(position.unrealizedPnl)} {formatPct(Math.abs(position.unrealizedPnlPct ?? 0), { sign: false })}
              </Text>
            </View>
          </View>

          <View style={styles.posStats}>
            <DetailRow label="Invested" value={formatUsd(position.costBasis)} />
            <DetailRow
              // The extension never routes this one through label(): that helper appends " price",
              // but the entry row is bare "Avg entry" — matching positions-list.
              label={priceDisplay === 'mcap' ? 'Avg entry MC' : 'Avg entry'}
              value={level.level(position.averageEntryPrice, position.entryMarketCapUsd)}
            />
          </View>

          <View style={styles.posActions}>
            <Btn label="Share" variant="share" icon="share" onPress={() => void sharePosition()} />
            <Btn label="Close" variant="danger" busy={trade.pending} onPress={trade.closePosition} />
          </View>
        </Card>
      ) : null}

      <Text style={styles.foot}>Simulated fills at live prices · no real funds</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { gap: 10 },
  card: { gap: 10, padding: 12 },

  presets: { flexDirection: 'row', gap: 6, flexWrap: 'wrap' },
  preset: {
    flexGrow: 1,
    minWidth: 54,
    alignItems: 'center',
    paddingVertical: 8,
    paddingHorizontal: 8,
    borderRadius: Radius.sm,
    borderWidth: 1,
    borderColor: Palette.lineStrong,
    backgroundColor: Palette.bgSecondary,
  },
  presetActive: { backgroundColor: Palette.paperT, borderColor: Palette.paperStrong },
  presetDisabled: { opacity: 0.4 },
  presetLabel: { fontSize: 13, fontWeight: '700', color: Palette.textSecondary, fontVariant: ['tabular-nums'] },
  maxLabel: { color: Palette.paper },
  gear: { flexGrow: 0, minWidth: 36, justifyContent: 'center' },

  editor: { gap: 8 },
  editorRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },

  muted: { fontSize: 13, color: Palette.textSecondary },
  available: { fontSize: 13, color: Palette.textSecondary, fontVariant: ['tabular-nums'] },
  tag: { fontSize: 11, fontWeight: '800', color: Palette.bgPrimary, letterSpacing: 0.5 },

  statusBody: { gap: 6 },
  statusPara: { fontSize: 12, color: Palette.textSecondary, lineHeight: 17 },

  posHead: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  posLead: { flex: 1, gap: 1 },
  posLevel: { fontSize: 16, fontWeight: '800', color: Palette.textPrimary, fontVariant: ['tabular-nums'] },
  posSub: { fontSize: 12, color: Palette.textSecondary, fontVariant: ['tabular-nums'] },
  posPnl: { alignItems: 'flex-end', gap: 1 },
  posPnlMain: { fontSize: 16, fontWeight: '800', fontVariant: ['tabular-nums'] },
  posPnlSub: { fontSize: 12, fontWeight: '700', fontVariant: ['tabular-nums'] },

  posStats: { gap: 4 },

  posActions: { flexDirection: 'row', gap: 8 },
  foot: { fontSize: 11, color: Palette.textTertiary, textAlign: 'center' },
});
