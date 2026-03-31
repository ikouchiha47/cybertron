import * as React from 'react';

import { AndroidtvViewProps } from './Androidtv.types';

export default function AndroidtvView(props: AndroidtvViewProps) {
  return (
    <div>
      <iframe
        style={{ flex: 1 }}
        src={props.url}
        onLoad={() => props.onLoad({ nativeEvent: { url: props.url } })}
      />
    </div>
  );
}
