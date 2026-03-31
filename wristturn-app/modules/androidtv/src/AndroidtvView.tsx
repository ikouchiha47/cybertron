import { requireNativeView } from 'expo';
import * as React from 'react';

import { AndroidtvViewProps } from './Androidtv.types';

const NativeView: React.ComponentType<AndroidtvViewProps> =
  requireNativeView('Androidtv');

export default function AndroidtvView(props: AndroidtvViewProps) {
  return <NativeView {...props} />;
}
