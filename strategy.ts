// Second Run — Pump.fun Paper Sprint (6-hour replay, pumpfun-replay/v2).
//
// Idea: most fresh curves are lottery tickets that bleed out — buying
// every newborn loses to fees and retraces on the dev window. The coins
// that pay are the ones that already proved they can run: a curve that
// printed 2.5x or more once has real demand behind it. This bot waits for
// such a runner to give its gains back and come home near its creation
// price, buys the dip small, and then lets the second run do the work:
// half off only at 5x, the rest at 10x, a tight stop just under the entry
// (a dip that keeps falling is a dead coin, not a bargain), a trailing
// stop once a new peak is banked, and a hard clock so no seat is held
// past its welcome. One scale-in is allowed when the second run confirms
// (1.5x the entry price, still under 2.5x creation).
//
// Everything is a pure function of the batches the harness delivers: no
// clock, no environment, no randomness, so the two graded executions of
// the same window decide the same orders.

import type { Batch, Bot, BotState, OrderInput } from './vendor/makefun-bot.ts';

// ---------------------------------------------------------------- tuning
// All sizes in lamports (1 SOL = 1_000_000_000). Chosen on the dev window
// with the offline sweep in tools/sim.py; the shipped values sit in the
// middle of the least-bad region, not on a single lucky spike.

const FIRST_BUY_LAMPORTS = 20_000_000n; // 0.02 SOL first tranche
const MIN_BUY_LAMPORTS = 10_000_000n; // never open below 0.01 SOL
const MIN_REAL_RESERVE_LAMPORTS = 1_000_000_000n; // wait for 1 SOL real
const DIP_PEAK_MULT = 2.5; // only coins that already ran 2.5x or more
const DIP_MAX_MULT = 1.15; // ... bought back down within 15% of base
const MAX_OPEN = 5; // harness cap; never promise a sixth seat
const CASH_FLOOR_LAMPORTS = 500_000_000n; // keep 0.5 SOL uncommitted
const SCALE_TRIGGER = 1.5; // scale in once price is 1.5x the entry
const SCALE_MAX_MULT = 2.5; // ... but not once it already ran past 2.5x
const SCALE_WINDOW_SLOTS = 400; // scale-in only shortly after entry
const TAKE_HALF_MULT = 5.0; // sell half the tokens at 5x creation price
const TAKE_ALL_MULT = 10.0; // sell the rest at 10x creation price
const STOP_FRAC = 0.95; // sell all at 5% below the entry price
const TRAIL_ARM_MULT = 2.5; // trailing stop arms once the peak hits 2.5x
const TRAIL_DROP = 0.3; // ... and fires on a 30% fall from that peak
const HOLD_SLOTS = 1200; // hard clock: out, whatever the chart says
const MAX_ORDERS_PER_BATCH = 8; // well under the harness cap of 16
const SLIPPAGE_BPS = 500;

interface Birth {
  slot: number;
  createPrice: number; // SOL per token at the CreateEvent
}

interface Ride {
  entrySlot: number;
  entryMult: number; // entry price as a multiple of the creation price
  peakMult: number;
  scaled: boolean;
  soldHalf: boolean;
}

function priceOf(curve: { virtual_token_reserves: bigint; virtual_quote_reserves: bigint }): number {
  const tokens = Number(curve.virtual_token_reserves);
  const quote = Number(curve.virtual_quote_reserves);
  if (tokens <= 0 || quote <= 0) return 0;
  return quote / tokens;
}

export function createSecondRun(): Bot {
  // Per-run memory, built fresh for every execution.
  const births = new Map<string, Birth>();
  const peaks = new Map<string, number>(); // highest multiple seen per mint
  const entered = new Set<string>(); // mints we already bought (or tried)
  const rides = new Map<string, Ride>();

  function pendingSell(state: BotState, mint: string): boolean {
    for (const p of state.pending.values()) {
      if (p.order.mint === mint && p.order.side === 'sell') return true;
    }
    return false;
  }

  function pendingBuy(state: BotState, mint: string): boolean {
    for (const p of state.pending.values()) {
      if (p.order.mint === mint && p.order.side === 'buy') return true;
    }
    return false;
  }

  function notePeak(state: BotState, mint: string): void {
    const birth = births.get(mint);
    const curve = state.curves.get(mint);
    if (birth === undefined || birth.createPrice <= 0 || curve === undefined) return;
    const mult = priceOf(curve) / birth.createPrice;
    if (mult > 0 && mult > (peaks.get(mint) ?? 0)) peaks.set(mint, mult);
  }

  function foldFills(state: BotState, batch: Batch): void {
    // Learn the true entry price from each buy fill: what we paid per
    // token is the only entry price that matters, not the quote we saw
    // two slots earlier when the order was decided.
    for (const fill of batch.fills) {
      if (fill.side !== 'buy' || fill.status !== 'filled') continue;
      const birth = births.get(fill.mint);
      if (birth === undefined) continue;
      if (rides.has(fill.mint)) continue;
      const spent = BigInt(fill.quote_lamports);
      const tokens = BigInt(fill.token_amount);
      if (spent <= 0n || tokens <= 0n) continue;
      const entryPrice = Number(spent) / Number(tokens);
      const entryMult = birth.createPrice > 0 ? entryPrice / birth.createPrice : 1;
      rides.set(fill.mint, {
        entrySlot: fill.decided_slot,
        entryMult,
        peakMult: entryMult,
        scaled: false,
        soldHalf: false,
      });
    }
  }

  function maybeBuy(state: BotState, batch: Batch, orders: OrderInput[]): void {
    if (state.committedPositionCount() >= MAX_OPEN) return;
    for (const event of batch.events) {
      if (orders.length >= MAX_ORDERS_PER_BATCH) return;
      if (event.event === 'CreateEvent') {
        births.set(event.mint, {
          slot: event.slot,
          createPrice: priceOf({
            virtual_token_reserves: BigInt(event.virtual_token_reserves),
            virtual_quote_reserves: BigInt(event.virtual_quote_reserves),
          }),
        });
        continue;
      }
      if (event.event !== 'TradeEvent') continue;
      const mint = event.mint;
      notePeak(state, mint);
      const birth = births.get(mint);
      if (birth === undefined || birth.createPrice <= 0) continue;
      if (entered.has(mint)) continue;
      if (state.positions.has(mint) || pendingBuy(state, mint)) continue;
      const curve = state.curves.get(mint);
      if (curve === undefined || curve.complete) continue;
      if (curve.real_quote_reserves < MIN_REAL_RESERVE_LAMPORTS) continue;
      // Only a proven runner, bought back down near its base.
      if ((peaks.get(mint) ?? 0) < DIP_PEAK_MULT) continue;
      const mult = priceOf(curve) / birth.createPrice;
      if (!(mult > 0) || mult > DIP_MAX_MULT) continue;
      const cap = state.maxBuyLamports(mint);
      const size = cap < FIRST_BUY_LAMPORTS ? cap : FIRST_BUY_LAMPORTS;
      if (size < MIN_BUY_LAMPORTS) continue;
      if (state.freeCashLamports() < size + CASH_FLOOR_LAMPORTS) continue;
      entered.add(mint);
      orders.push({
        side: 'buy',
        mint,
        quote_lamports: size,
        max_slippage_bps: SLIPPAGE_BPS,
      });
    }
  }

  function maybeScale(state: BotState, orders: OrderInput[]): void {
    for (const [mint, ride] of rides) {
      if (orders.length >= MAX_ORDERS_PER_BATCH) return;
      if (ride.scaled) continue;
      const curve = state.curves.get(mint);
      const birth = births.get(mint);
      const holding = state.positions.get(mint);
      if (curve === undefined || birth === undefined || holding === undefined) continue;
      if (curve.complete || pendingBuy(state, mint)) continue;
      if (state.slot - ride.entrySlot > SCALE_WINDOW_SLOTS) continue;
      const mult = priceOf(curve) / birth.createPrice;
      if (mult < ride.entryMult * SCALE_TRIGGER || mult > SCALE_MAX_MULT) continue;
      const cap = state.maxBuyLamports(mint);
      const size = cap < FIRST_BUY_LAMPORTS ? cap : FIRST_BUY_LAMPORTS;
      if (size < MIN_BUY_LAMPORTS) continue;
      if (state.freeCashLamports() < size + CASH_FLOOR_LAMPORTS) continue;
      ride.scaled = true;
      orders.push({
        side: 'buy',
        mint,
        quote_lamports: size,
        max_slippage_bps: SLIPPAGE_BPS,
      });
    }
  }

  function maybeExit(state: BotState, orders: OrderInput[]): void {
    for (const [mint, holding] of state.positions) {
      if (orders.length >= MAX_ORDERS_PER_BATCH) return;
      const ride = rides.get(mint);
      const curve = state.curves.get(mint);
      const birth = births.get(mint);
      if (ride === undefined || curve === undefined || birth === undefined) continue;
      if (pendingSell(state, mint)) continue;
      const mult = priceOf(curve) / birth.createPrice;
      if (!(mult > 0)) continue;
      if (mult > ride.peakMult) ride.peakMult = mult;
      const tokens = holding.token_amount;
      if (tokens <= 0n) continue;
      let sell: bigint | null = null;
      if (mult >= TAKE_ALL_MULT) {
        sell = tokens;
      } else if (!ride.soldHalf && mult >= TAKE_HALF_MULT) {
        sell = tokens / 2n;
        ride.soldHalf = true;
      } else if (mult <= ride.entryMult * STOP_FRAC) {
        sell = tokens;
      } else if (ride.peakMult >= TRAIL_ARM_MULT && mult <= ride.peakMult * (1 - TRAIL_DROP)) {
        sell = tokens;
      } else if (state.slot - ride.entrySlot >= HOLD_SLOTS) {
        sell = tokens;
      }
      if (sell !== null && sell > 0n) {
        orders.push({ side: 'sell', mint, token_amount: sell, max_slippage_bps: SLIPPAGE_BPS });
      }
    }
  }

  return {
    onBatch(state, batch) {
      foldFills(state, batch);
      // Drop bookkeeping for positions the harness already closed.
      for (const mint of [...rides.keys()]) {
        if (!state.positions.has(mint) && !pendingBuy(state, mint)) rides.delete(mint);
      }
      const orders: OrderInput[] = [];
      maybeBuy(state, batch, orders);
      maybeScale(state, orders);
      maybeExit(state, orders);
      return orders;
    },
  };
}
