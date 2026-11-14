/** What a hosted model costs, in micro-USD per million tokens (ADR 0023): the Governor's route carries it, the runner prices attempts with it. */
export interface HostedPrices { readonly inputMicroUsdPerMTok: number; readonly outputMicroUsdPerMTok: number }

/**
 * The cost of an attempt on the hosted route in whole micro-USD, rounded up so a small attempt is never free. Cached input is priced like
 * input: the route carries two prices only, and a cache must never make spend look smaller than it is.
 */
export function hostedMicroUsd(prices: HostedPrices, tokens: { input: number; cacheRead: number; output: number }): number {
  return Math.ceil(((tokens.input + tokens.cacheRead) * prices.inputMicroUsdPerMTok + tokens.output * prices.outputMicroUsdPerMTok) / 1_000_000);
}
