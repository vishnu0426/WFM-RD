/**
 * Stateful in-memory double for expo-secure-store — neither this nor
 * expo-local-authentication is auto-mocked by jest-expo's preset, and unlike
 * `@react-native-async-storage/async-storage` (which ships its own official
 * jest mock), expo-secure-store doesn't provide one.
 */
const store = new Map<string, string>();

export async function setItemAsync(key: string, value: string): Promise<void> {
  store.set(key, value);
}

export async function getItemAsync(key: string): Promise<string | null> {
  return store.has(key) ? store.get(key)! : null;
}

export async function deleteItemAsync(key: string): Promise<void> {
  store.delete(key);
}

export function __reset(): void {
  store.clear();
}
