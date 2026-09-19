/**
 * The rewards client: a Milk account, a server-verified Last.fm link, and the
 * stickers the server has granted.
 *
 * All of it is additive. With no account (or no network, or no Supabase config
 * in the build) the app is exactly the offline shelf it was before; nothing
 * here makes a request until someone signs in.
 */

export { rewardsApi } from './client';
export type { RewardsApi } from './api';
export * from './types';
export { reasonText } from './messages';
export { sessionPersists } from './secureSession';
export { RewardsProvider, useRewards } from './RewardsContext';
