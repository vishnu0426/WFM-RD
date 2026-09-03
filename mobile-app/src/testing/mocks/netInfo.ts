/** Controllable double for @react-native-community/netinfo — its real
 * native module isn't available under Jest and the default RN auto-mock
 * doesn't fully implement the internal reachability state machine
 * (`internetReachability.ts` crashes on `state.isInternetReachable` when
 * fed an incomplete event). */
export interface MockNetInfoState {
  isConnected: boolean;
  isInternetReachable: boolean | null;
}

type Listener = (state: MockNetInfoState) => void;

let listeners: Listener[] = [];

function addEventListener(listener: Listener): () => void {
  listeners.push(listener);
  listener({ isConnected: true, isInternetReachable: true });
  return () => {
    listeners = listeners.filter((existing) => existing !== listener);
  };
}

export function __emit(state: MockNetInfoState): void {
  listeners.forEach((listener) => listener(state));
}

export function __reset(): void {
  listeners = [];
}

export default { addEventListener };
