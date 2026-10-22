import { Capacitor, registerPlugin } from '@capacitor/core';
export const isNative = () => Capacitor.isNativePlatform();
export interface NativeAuthPlugin {
  login(options: { apiOrigin: string }): Promise<void>;
  token(options: { apiOrigin: string }): Promise<{ token: string | null }>;
  clear(options: { apiOrigin: string }): Promise<void>;
}
export const NativeAuth = registerPlugin<NativeAuthPlugin>('NativeAuth');
