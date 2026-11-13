// Calendar facts are owned by bonCal; payroll templates remain in BonBills.
export * from '../boncal/daily.js';
import { DEFAULT_INTERNSHIP_RULES } from '../boncal/daily.js';
import type { AppConfig, InternshipProfile } from '../models/types.js';

export function migratedProfiles(config: Partial<AppConfig>): InternshipProfile[] {
  if (config.internshipProfiles) return config.internshipProfiles.map(profile => {
    const legacy = (config.incomeItems ?? []).find(item => item.id === profile.legacyIncomeId);
    return profile.legacyIncomeId && (profile.name === '当前公司' || profile.name === legacy?.name)
      ? { ...profile, name: '字节模式' } : profile;
  });
  return (config.incomeItems ?? []).filter(i => i.dailyRate !== undefined && i.tagKind === 'intern').map(i => ({
    id: `company_${i.id}`, name: '字节模式', revision: 1, legacyIncomeId: i.id,
    rules: { ...DEFAULT_INTERNSHIP_RULES, salary: i.dailyRate!, taxRuleText: i.taxRuleText,
      cycle: 'beforePay', payMonthOffset: 0, payKind: 'lastWorkingDay' },
  }));
}
export function showsCompanyPayrollCutoff(profile: InternshipProfile | undefined, legacyPreference = true): boolean {
  return profile?.showPayrollCutoffMarkers ?? (profile?.legacyIncomeId ? legacyPreference : true);
}
