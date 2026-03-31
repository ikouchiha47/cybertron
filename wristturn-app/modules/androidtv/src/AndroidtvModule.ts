import { NativeModule, requireNativeModule } from 'expo';

import { AndroidtvModuleEvents } from './Androidtv.types';

declare class AndroidtvModule extends NativeModule<AndroidtvModuleEvents> {
  PI: number;
  hello(): string;
  setValueAsync(value: string): Promise<void>;
}

// This call loads the native module object from the JSI.
export default requireNativeModule<AndroidtvModule>('Androidtv');
