[![Pump.fun Paper Sprint: Any Bot Can Win](https://make.fun/badge/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b.svg)](https://make.fun/c/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b)
[![Rank](https://make.fun/badge/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b/rrmmllnn/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b/rank.svg)](https://make.fun/c/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b)
[![Reward](https://make.fun/badge/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b/rrmmllnn/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b/reward.svg)](https://make.fun/c/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b)

# Second Run — Pump.fun Paper Sprint: Any Bot Can Win

A Solana paper-trading bot for the house `pumpfun-replay` template. It trades
10 SOL of paper money on a replay of pump.fun bonding-curve data.

## Idea

Most fresh curves are lottery tickets that bleed out: on the dev window,
buying every newborn loses to fees and retraces, and chasing a big buy
fills at the top of the spike two slots too late. The coins that pay are
the ones that already proved they can run. This bot waits for a curve
that printed 2.5x or more to give its gains back and come home near its
creation price, buys that dip small (0.02 SOL), and then lets the second
run do the work: half off only at 5x creation, the rest at 10x, a tight
stop 5% under the entry price (a dip that keeps falling is a dead coin,
not a bargain), a trailing stop once a new peak is banked, and a hard
1,200-slot clock. One scale-in is allowed when the second run confirms
(1.5x the entry price, still under 2.5x creation). At most five positions
are open at once.

## Layout

- `main.ts` — entrypoint, run by the grader as `node /bot/main.ts`
- `strategy.ts` — the whole strategy (pure function of the batches: no clock,
  no randomness, no I/O, so the two graded executions decide the same orders)
- `vendor/makefun-bot.ts` — the kit's SDK shim, copied unchanged

## Dev-window result

Kit's frozen dev data, local grade (`grade-local --driver process`):

- Net PnL **-0.140 SOL** over 118 coins, 237 fills, win rate 7.6%,
  max drawdown 1.5%. Guardrails met (118 coins hold a round trip of at
  least 0.01 SOL, drawdown well under 50%).
- Stress (5 rebuilt copies of the dev window): median -0.10 SOL, p10
  -0.14, p90 -0.07; all 5 copies lost money. The dev score sits at the
  weak end of its own spread, so treat the -0.14 as the honest
  expectation on dev-like data, not a fluke draw: the edge is thin and
  the final 6-hour window is a different draw.
- For scale: on the same window the house momentum pilot lost 9.45 SOL,
  the reversion pilot 4.37 SOL, the sniper pilot 0.42 SOL, and a
  buy-every-newborn version of this bot lost 0.55 SOL. The dev window is
  a hard one for buyers; this entry is the least-bad guardrail-passing
  shape found, with its upside kept in the 5x/10x exits rather than in
  chasing spikes.

## Grade locally

From the unpacked kit directory:

```sh
node cli/makefun.mjs grade-local --kit . --bot <path-to-this-repo> --driver process
```
