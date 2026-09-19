import { createContext, useContext } from 'react';
import type { Backend, RuleFunctions } from './backend/types';
import type { Session } from './types';

export interface Ctx {
  backend: Backend;
  fns: RuleFunctions;
  session: Session;
  navigate: (hash: string) => void;
}

export const AppCtx = createContext<Ctx | null>(null);

export function useApp(): Ctx {
  const c = useContext(AppCtx);
  if (!c) throw new Error('useApp outside provider');
  return c;
}
