import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { appIdentity, isLifeApp, LIFE_SECTIONS } from './apps';

describe('BonLog independent domains', () => {
  it.each([
    ['fit', 'BonFit', 'training'], ['well', 'BonWell', 'well'], ['done', 'DoneList', 'done'],
  ] as const)('opens %s with its own page and install manifest', (kind, name, view) => {
    const app = appIdentity(`${kind}.bonbills.cn`, '/');
    expect(app).toMatchObject({ kind, name, url: `https://${kind}.bonbills.cn/` });
    expect(isLifeApp(app.kind)).toBe(true);
    expect(LIFE_SECTIONS[kind]).toBe(view);
    expect(JSON.parse(readFileSync(`public${app.manifest}`, 'utf8'))).toMatchObject({
      name, short_name: name, start_url: '/', scope: '/', display: 'standalone',
    });
  });

  it('opens the dedicated Orche login with an independent install manifest', () => {
    const app = appIdentity('orche.bonbills.cn', '/');
    expect(app).toMatchObject({ kind: 'orche', name: 'Orche', url: 'https://orche.bonbills.cn/' });
    expect(isLifeApp(app.kind)).toBe(true);
    expect(JSON.parse(readFileSync(`public${app.manifest}`, 'utf8'))).toMatchObject({
      name: 'Orche', start_url: '/', scope: '/', display: 'standalone',
    });
  });

  it('retains existing BonLog links and the other apps', () => {
    expect(appIdentity('log.bonbills.cn', '/').kind).toBe('log');
    expect(appIdentity('life.bonbills.cn', '/').kind).toBe('log');
    expect(appIdentity('www.bonbills.cn', '/life').kind).toBe('log');
    expect(appIdentity('www.bonbills.cn', '/log').kind).toBe('log');
    expect(appIdentity('clothes.bonbills.cn', '/').kind).toBe('clothes');
    expect(appIdentity('bill.bonbills.cn', '/').kind).toBe('bills');
  });
});
