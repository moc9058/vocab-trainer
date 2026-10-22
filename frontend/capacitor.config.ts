import type { CapacitorConfig } from '@capacitor/cli';
const config: CapacitorConfig = {
  appId: 'jp.moc9058.vocabtrainer',
  appName: 'Vocab Trainer',
  webDir: 'dist-ios',
  loggingBehavior: 'none',
  server: { iosScheme: 'capacitor', hostname: 'localhost' },
  ios: { contentInset: 'never', scrollEnabled: false },
  plugins: { CapacitorHttp: { enabled: false }, Keyboard: { resize: 'native' } },
};
export default config;
