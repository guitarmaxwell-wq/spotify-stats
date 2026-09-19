/**
 * Which backend the app talks to. Always the real one, except in a development
 * web build opened with `?rewardsStub=<scenario>` (see stub.ts), which exists
 * so the UI can be looked at before the Edge Functions are deployed.
 * A production bundle strips that branch, because __DEV__ is false there.
 */

import { Platform } from 'react-native';

import { realApi, type RewardsApi } from './api';
import { makeStubApi } from './stub';

function pickApi(): RewardsApi {
  if (__DEV__ && Platform.OS === 'web' && typeof window !== 'undefined') {
    const q = new URLSearchParams(window.location.search);
    const scenario = q.get('rewardsStub');
    if (scenario) return makeStubApi(scenario, q);
  }
  return realApi;
}

export const rewardsApi: RewardsApi = pickApi();
