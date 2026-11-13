import { createHash } from 'node:crypto';

// Exact source fingerprints: changed or new Redis scripts must receive an
// explicitly reviewed SQL transaction port. Never guess or execute Lua in SQL.
export const STORAGE_SCRIPT_IDS = {
  "3e026d744a9ca2e7ed3dea7ea2ab96a2c867f3c3d632c33a7f34dcf620d8c985": "save-well", // SAVE_WELL
  'f3fbe77889cedb7cf08eb4692371af7fb3c7960b76559c7be435943cfb27ee20': 'read-make-quota', // READ_MAKE_QUOTA
  '877136d8c4f71a457b61728ffbab0948edbdbbdc94142c16f50f25643f400573': 'save-clothes', // SAVE_CLOTHES
  '2072bbda9166cb2a6dd95c091af8899cb7f66b0cffb4757d90163944e1089a35': 'save-periods', // _bonLife.ts:70
  'a8ece85b84d90375c90e79cd7941faa68e5d8f6c1f2b184cb2861a1f282db5fb': 'save-life-entry', // SAVE_LIFE_ENTRY
  '6c50b2210556421f0b90f513616098c44ca0baf10eba069a473971db8987b7bf': 'photo-sizes', // READ_PHOTO_SIZES
  'fadbcefd074a43c2a42a697b9594dd59cfa2ae5fb76e0990fedd434035f2a11a': 'compress-photo', // COMPRESS_PHOTO
  'afeb9c4d540f6ccec562bf417fee764c2632d4fea5f9ac0b7296b5a0d3d04764': 'migrate-photo', // MIGRATE_PHOTO
  '8ef42dfc80ab76feea9871a048b5900eb66cc89c86ada259ee3e8ee06275b144': 'read-photo', // READ_PHOTO
  '5551fd42e2fcd7ddedfea11654500ed7f5f37c0be075e951bc8e03f3eeb8f02d': 'wear-page', // READ_WEAR_PAGE
  '9f854ece6c3c838b524c283a33661ced5d1ae0bdf7b59f5b6c6f7b4cc8913de6': 'release-email', // _dailyEmail.ts:73
  '42ef10274e4b3df3a077b0d424796d05b1e981aeaa97418cca49ed0c1be6a5f9': 'save-done', // _lifeDone.ts:96
  '11ae0f7ca2138d4c00e37db90375cd1b83151b8b7477feb53bc5fe0cb0cea18d': 'save-outlook-done', // _lifeDoneOutlook.ts:62
  '73d721613f7ec00a1a4d5d02b86dd04e15d0aed07914d336370a32f67fc6cb2d': 'save-training', // _lifeTraining.ts:218
  '58c1e79c3e95626750ef05e2e74a7f650a45d44acbee56a3fa9df61b30d58631': 'release-lock', // _outlookSync.ts:25
  'a87e04a1816e4a665e6519df6789d9bf9db34d3ddcf183496b35ba8987a8cdc2': 'renew-outlook-lock', // _outlookWrite.ts:41
  '612fcba62858af46534a0b2b8de65e8137f32bb3a0a23223d6a5db95066886cc': 'release-lock', // _ticktickLock.ts:10
  'ef500d4710651811d9614a5d119851752921a384c58b2f1419ae9b73950307c9': 'reserve-make', // _outlookWrite.ts:125
  '5124013c1a67bc9e3c3192880260c6146dbe204d1abe591eba22fecce2f7e3fa': 'compare-set', // compareAndSet
} as const;
export type StorageOperation = typeof STORAGE_SCRIPT_IDS[keyof typeof STORAGE_SCRIPT_IDS];
export function storageOperation(script: string): StorageOperation {
  const hash = createHash('sha256').update(script.trim()).digest('hex');
  const operation = STORAGE_SCRIPT_IDS[hash as keyof typeof STORAGE_SCRIPT_IDS];
  if (!operation) throw new Error('Unsupported storage transaction');
  return operation;
}
