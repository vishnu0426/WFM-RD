/** Controllable double for expo-local-authentication. */
let hardwareAvailable = true;
let enrolled = true;
let nextAuthResult = { success: true };

export async function hasHardwareAsync(): Promise<boolean> {
  return hardwareAvailable;
}

export async function isEnrolledAsync(): Promise<boolean> {
  return enrolled;
}

export async function authenticateAsync(): Promise<{ success: boolean }> {
  return nextAuthResult;
}

export function __setHardwareAvailable(value: boolean): void {
  hardwareAvailable = value;
}

export function __setEnrolled(value: boolean): void {
  enrolled = value;
}

export function __setNextAuthResult(result: { success: boolean }): void {
  nextAuthResult = result;
}

export function __reset(): void {
  hardwareAvailable = true;
  enrolled = true;
  nextAuthResult = { success: true };
}
