import React from 'react';
import { requireNativeComponent, StyleSheet, ViewStyle } from 'react-native';

interface Props {
  url: string;
  streamId?: string;
  inferenceIntervalMs?: number;
  detectionEnabled?: boolean;
  style?: ViewStyle;
}

// @ts-ignore
const NativeMjpegStreamView = requireNativeComponent<Props>('MjpegStreamView');

export default function MjpegStream({ url, streamId = 'default', inferenceIntervalMs = 1000, detectionEnabled = true, style }: Props) {
  return (
    <NativeMjpegStreamView
      url={url}
      streamId={streamId}
      inferenceIntervalMs={inferenceIntervalMs}
      detectionEnabled={detectionEnabled}
      style={[StyleSheet.absoluteFill, style]}
    />
  );
}
