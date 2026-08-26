import { Box, Text } from 'ink';
import type { ReactNode } from 'react';
import { viewPaneSize } from './context.js';
import { theme } from '../theme.js';

/**
 * A dialog that floats over the view instead of displacing it.
 *
 * Two things make this work in a terminal. Ink supports `position="absolute"`,
 * so the box is taken out of the flow and painted after (and therefore over)
 * the content behind it — but it only writes cells that hold characters, so a
 * bordered box alone is *transparent*: the board shows through the gaps
 * between its own words. The fix is the backdrop below, an explicit block of
 * spaces at the same coordinates, drawn first.
 *
 * Height is given rather than measured, because yoga lays the box out after we
 * would need the number. Overshooting is harmless — the dialog is simply
 * roomier — while undershooting clips it, so callers round up.
 */
export function Popup(props: {
  /** total width including borders */
  width: number;
  /** total height including borders; content taller than this is clipped */
  height: number;
  top: number;
  left: number;
  borderColor?: string;
  children: ReactNode;
}) {
  const { width, height, top, left, borderColor = theme.key, children } = props;
  return (
    <>
      {/* opaque: without this the view behind shows through every gap */}
      <Box position="absolute" marginTop={top} marginLeft={left} flexDirection="column">
        {Array.from({ length: height }, (_, i) => (
          <Text key={i}>{' '.repeat(width)}</Text>
        ))}
      </Box>
      <Box
        position="absolute"
        marginTop={top}
        marginLeft={left}
        width={width}
        height={height}
        overflow="hidden"
        borderStyle="double"
        borderColor={borderColor}
        paddingX={1}
        flexDirection="column"
      >
        {children}
      </Box>
    </>
  );
}

/** Rows a dispatch/edit form of `fields` fields needs, including the frame. */
export function formHeight(fields: number, extraLines = 0): number {
  // title + fields + footer, inside the border
  return fields + extraLines + 4;
}

/** Centre a dialog of this size in the view pane, without running off it. */
export function popupPlacement(
  size: { columns: number; rows: number },
  wanted: { width: number; height: number },
  cmdOpen = false,
): { width: number; height: number; top: number; left: number } {
  const { width: viewWidth, height: viewHeight } = viewPaneSize(size, cmdOpen);
  const width = Math.min(wanted.width, viewWidth);
  const height = Math.min(wanted.height, viewHeight);
  return {
    width,
    height,
    top: Math.max(0, Math.floor((viewHeight - height) / 2)),
    left: Math.max(0, Math.floor((viewWidth - width) / 2)),
  };
}
