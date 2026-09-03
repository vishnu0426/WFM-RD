import * as Notifications from 'expo-notifications';
import { Platform } from 'react-native';
import { AndroidImportance } from 'expo-notifications';

/**
 * ADR-0154. `getExpoPushTokenAsync()` requires a real EAS `projectId` -
 * an external, account-level prerequisite (`eas init` against a real Expo
 * account/project) this repo's code can plumb for but not itself
 * provision. Fails loud with a named error rather than calling the SDK
 * with an undefined `projectId` and getting an opaque failure, same
 * posture `getMobileEssApiBaseUrl()` already uses for a missing env var.
 */
function requireEasProjectId(): string {
  const projectId = process.env.EXPO_PUBLIC_EAS_PROJECT_ID;
  if (!projectId) {
    throw new Error(
      'Missing EXPO_PUBLIC_EAS_PROJECT_ID - push notifications require a real EAS project ' +
        '(run `eas init`, then copy the project id into .env). Not provisionable from this repo alone.',
    );
  }
  return projectId;
}

/**
 * Requests notification permission and returns an Expo push token, or
 * `null` if the user declined - a normal outcome, not an error
 * (`useRegisterDeviceOnAuth` treats `null` as "nothing to register this
 * session," never surfaces it to the employee). Android requires a
 * notification channel to exist before a token can be requested, so the
 * default channel is created first on that platform only.
 */
export async function getOrRequestPushToken(): Promise<string | null> {
  if (Platform.OS === 'android') {
    await Notifications.setNotificationChannelAsync('default', {
      name: 'default',
      importance: AndroidImportance.DEFAULT,
    });
  }

  const existing = await Notifications.getPermissionsAsync();
  const settled = existing.granted ? existing : await Notifications.requestPermissionsAsync();
  if (!settled.granted) {
    return null;
  }

  const projectId = requireEasProjectId();
  const token = await Notifications.getExpoPushTokenAsync({ projectId });
  return token.data;
}
