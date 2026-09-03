import { useCallback, useEffect, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';

import { Touchable } from '@/components/ui/Touchable';
import { colors } from '@/lib/a11y/tokens';
import { dismissConflict, listConflicts, QueuedConflict } from '@/offlineQueue/conflicts';
import { OfflineActionType } from '@/offlineQueue/storage';

/**
 * The backend's own conflict message is already action-type-specific
 * (docs/adr/0153 — e.g. `POST_NOT_OPEN` reads "this shift's status
 * changed while you were offline," not narrowly "someone else claimed
 * it," since `cancelled`/`expired` are real, distinct possibilities). This
 * label just adds the "what kind of queued action was this" framing the
 * raw message alone doesn't carry.
 */
function getActionTypeLabel(actionType: OfflineActionType): string {
  switch (actionType) {
    case 'clock_event':
      return 'Clock event';
    case 'leave_request':
      return 'Leave request';
    case 'marketplace_claim':
      return 'Shift claim';
  }
}

/**
 * Surfaces unresolved sync conflicts (source spec's non-negotiable: never
 * silently dropped or auto-resolved). Dismiss is the only supported action
 * this phase — see `conflicts.ts`'s own doc comment for why a richer
 * resolution flow isn't built here.
 */
export function ConflictBanner() {
  const [conflicts, setConflicts] = useState<QueuedConflict[]>([]);

  const refresh = useCallback(() => {
    listConflicts().then(setConflicts);
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const handleDismiss = async (id: string) => {
    await dismissConflict(id);
    refresh();
  };

  if (conflicts.length === 0) {
    return null;
  }

  return (
    <View style={styles.container}>
      {conflicts.map((conflict) => (
        <View key={conflict.id} style={styles.banner} accessibilityRole="alert">
          <View style={styles.textColumn}>
            <Text style={styles.label}>{getActionTypeLabel(conflict.actionType)}</Text>
            <Text style={styles.message}>{conflict.message}</Text>
          </View>
          <Touchable
            onPress={() => handleDismiss(conflict.id)}
            accessibilityRole="button"
            accessibilityLabel="Dismiss"
            style={styles.dismissButton}
          >
            <Text style={styles.dismissText}>Dismiss</Text>
          </Touchable>
        </View>
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    paddingHorizontal: 20,
    gap: 8,
    marginBottom: 8,
  },
  banner: {
    backgroundColor: colors.warningBackground,
    borderRadius: 8,
    padding: 12,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 12,
  },
  textColumn: {
    flex: 1,
    gap: 2,
  },
  label: {
    color: colors.warningText,
    fontSize: 12,
    fontWeight: '700',
  },
  message: {
    color: colors.warningText,
    fontSize: 13,
  },
  dismissButton: {
    paddingHorizontal: 8,
  },
  dismissText: {
    color: colors.warningText,
    fontSize: 13,
    fontWeight: '700',
  },
});
