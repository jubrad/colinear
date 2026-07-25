import { Box, Text } from 'ink';
import { theme } from '../theme.js';
import type { ToastKind } from './context.js';

const KIND_COLORS: Record<ToastKind, string> = { info: theme.accent, ok: theme.ok, err: theme.err };

export function Crumbs(props: {
  trail: string[];
  toast?: { text: string; kind: ToastKind };
  width: number;
}) {
  const { trail, toast, width } = props;
  return (
    <Box width={width} justifyContent="space-between" flexShrink={0}>
      <Box>
        {trail.map((crumb, i) => (
          <Text key={`${i}-${crumb}`}>
            <Text
              backgroundColor={i === trail.length - 1 ? theme.key : theme.border}
              color="black"
              bold={i === trail.length - 1}
            >
              {` ${crumb} `}
            </Text>
            <Text> </Text>
          </Text>
        ))}
      </Box>
      {toast && <Text color={KIND_COLORS[toast.kind]}>{toast.text}</Text>}
    </Box>
  );
}
