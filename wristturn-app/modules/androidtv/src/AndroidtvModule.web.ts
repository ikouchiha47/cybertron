import { registerWebModule, NativeModule } from 'expo';

import { ChangeEventPayload } from './Androidtv.types';

type AndroidtvModuleEvents = {
  onChange: (params: ChangeEventPayload) => void;
}

class AndroidtvModule extends NativeModule<AndroidtvModuleEvents> {
  PI = Math.PI;
  async setValueAsync(value: string): Promise<void> {
    this.emit('onChange', { value });
  }
  hello() {
    return 'Hello world! 👋';
  }
};

export default registerWebModule(AndroidtvModule, 'AndroidtvModule');
