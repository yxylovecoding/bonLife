export const ORCHE_HOST = 'orche.bonbills.cn';

export const APP_LINKS = {
  bills: { name: 'BonBills', url: 'https://bill.bonbills.cn/', icon: 'bonbills' },
  log: { name: 'BonLog', url: 'https://log.bonbills.cn/', icon: 'bonlife' },
  fit: { name: 'BonFit', url: 'https://fit.bonbills.cn/', icon: 'bonlife' },
  well: { name: 'BonWell', url: 'https://well.bonbills.cn/', icon: 'bonlife' },
  done: { name: 'DoneList', url: 'https://done.bonbills.cn/', icon: 'bonlife' },
  orche: { name: 'Orche', url: `https://${ORCHE_HOST}/`, icon: 'bonlife' },
  clothes: { name: 'BonClothes', url: 'https://clothes.bonbills.cn/', icon: 'bonclothes' },
  cv: { name: 'BonCV', url: 'https://cv.bonbills.cn/' },
} as const;
export const LIFE_SECTIONS = { well: 'well', fit: 'training', done: 'done' } as const;
export type LifeAppKind = 'log' | keyof typeof LIFE_SECTIONS;
export type AppKind = LifeAppKind | 'orche' | 'bills' | 'clothes';
export const isLifeApp = (kind: AppKind): kind is LifeAppKind | 'orche' => kind !== 'bills' && kind !== 'clothes';

export function appIdentity(hostname: string, pathname: string) {
  if (hostname === ORCHE_HOST) return { kind: 'orche' as const, ...APP_LINKS.orche, manifest: '/bonorche.webmanifest' };
  const clothesHost = hostname === 'clothes.bonbills.cn';
  const logHost = hostname === 'log.bonbills.cn' || hostname === 'life.bonbills.cn';
  const section = (Object.keys(LIFE_SECTIONS) as (keyof typeof LIFE_SECTIONS)[]).find(key => hostname === `${key}.bonbills.cn`);
  const kind: AppKind = section ?? (clothesHost || /^\/clothes(?:\/|$)/.test(pathname) ? 'clothes'
    : logHost || /^\/(?:life|log)(?:\/|$)/.test(pathname) ? 'log' : 'bills');
  const manifest = section ? `/bon${section}.webmanifest`
    : kind === 'clothes' ? (clothesHost ? '/bonclothes-root.webmanifest' : '/bonclothes.webmanifest')
    : kind === 'log' ? (logHost ? '/bonlog.webmanifest' : /^\/life(?:\/|$)/.test(pathname) ? '/bonlife-path.webmanifest' : '/bonlog-path.webmanifest')
      : '/bonbills.webmanifest';
  return { kind, ...APP_LINKS[kind], manifest };
}
