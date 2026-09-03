import { forwardRef } from 'react';
import { Pressable, PressableProps } from 'react-native';

/** iOS HIG minimum 44x44pt / Android Material minimum 48x48dp hit target
 * (docs/adr/0147). Use this instead of a bare Pressable for any tappable
 * element so the minimum is enforced in one place, not per-callsite. */
const MIN_HIT_TARGET = 48;

export type TouchableProps = PressableProps;

export const Touchable = forwardRef<React.ElementRef<typeof Pressable>, TouchableProps>(
  ({ style, hitSlop, ...rest }, ref) => {
    return (
      <Pressable
        ref={ref}
        hitSlop={hitSlop ?? 8}
        style={(state) => [
          { minWidth: MIN_HIT_TARGET, minHeight: MIN_HIT_TARGET, justifyContent: 'center' },
          typeof style === 'function' ? style(state) : style,
        ]}
        {...rest}
      />
    );
  },
);

Touchable.displayName = 'Touchable';
