/**
 * What the admin chose on each chart on the overview — which period, how far back,
 * which dates, how many months — kept in one small cookie so the charts come back
 * exactly as they were left, until the admin changes them.
 *
 * It is a cookie (not browser storage) so the server can read it and draw the
 * first view already set up: no flash of the default period before the saved one
 * arrives. It holds only chart choices — no account data, nothing secret — is
 * scoped to /admin, and is per browser: another browser starts from the defaults.
 *
 * This file is shared by the client (which writes it) and the server (which
 * reads it, in `chart-settings-server.ts`, where every value is validated again).
 */

export const CHART_SETTINGS_COOKIE = 'cn_admin_charts';

export type SettingsRange = 'day' | 'week' | 'month' | 'custom';

export interface PeriodSetting {
  range: SettingsRange;
  offset: number;
  from?: string;
  to?: string;
}

export interface MonthsSetting {
  months: number;
}

export interface ChartSettings {
  hours?: PeriodSetting;
  subjects?: PeriodSetting;
  active?: MonthsSetting;
  registrations?: MonthsSetting;
}

function readRaw(): ChartSettings {
  try {
    const match = document.cookie.split('; ').find((part) => part.startsWith(`${CHART_SETTINGS_COOKIE}=`));
    if (!match) return {};
    return JSON.parse(decodeURIComponent(match.slice(CHART_SETTINGS_COOKIE.length + 1))) as ChartSettings;
  } catch {
    return {};
  }
}

/** Remembers one chart's setting, leaving the others as they were. Never throws. */
export function saveChartSetting<K extends keyof ChartSettings>(key: K, value: NonNullable<ChartSettings[K]>): void {
  try {
    const next = { ...readRaw(), [key]: value };
    document.cookie = `${CHART_SETTINGS_COOKIE}=${encodeURIComponent(JSON.stringify(next))}; path=/admin; max-age=31536000; SameSite=Lax`;
  } catch {
    /* a blocked cookie just means the settings are not remembered */
  }
}
