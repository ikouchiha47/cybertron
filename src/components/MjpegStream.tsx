import React from 'react';
import { requireNativeComponent, StyleSheet, ViewStyle } from 'react-native';

interface Props {
  url: string;
  inferenceIntervalMs?: number;
  style?: ViewStyle;
}

// @ts-ignore
const NativeMjpegStreamView = requireNativeComponent<Props>('MjpegStreamView');

export default function MjpegStream({ url, inferenceIntervalMs = 1000, style }: Props) {
  return (
    <NativeMjpegStreamView
      url={url}
      inferenceIntervalMs={inferenceIntervalMs}
      style={[StyleSheet.absoluteFill, style]}
    />
  );
}
