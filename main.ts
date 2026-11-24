// Second Run — entrypoint. The grader runs `node /bot/main.ts`.
// All decisions live in strategy.ts; this file only starts the harness
// loop from the kit's vendor shim.
import { runBot } from './vendor/makefun-bot.ts';
import { createSecondRun } from './strategy.ts';

await runBot(createSecondRun());
