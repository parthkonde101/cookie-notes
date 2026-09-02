import 'server-only';
import { headers } from 'next/headers';
import { UAParser } from 'ua-parser-js';

export interface RequestContext {
  ip: string | null;
  userAgent: string | null;
  device: string | null;
  browser: string | null;
  os: string | null;
}

function firstForwarded(value: string | null): string | null {
  if (!value) return null;
  const first = value.split(',')[0]?.trim();
  return first && first.length > 0 ? first : null;
}

export function contextFromHeaders(h: Headers): RequestContext {
  const userAgent = h.get('user-agent');
  const ip =
    firstForwarded(h.get('x-forwarded-for')) ??
    h.get('x-real-ip') ??
    h.get('cf-connecting-ip') ??
    null;

  let device: string | null = null;
  let browser: string | null = null;
  let os: string | null = null;

  if (userAgent) {
    const parsed = new UAParser(userAgent).getResult();
    const deviceParts = [parsed.device.vendor, parsed.device.model].filter(Boolean).join(' ');
    device = deviceParts || (parsed.device.type ? parsed.device.type : 'Desktop');
    browser = [parsed.browser.name, parsed.browser.version?.split('.')[0]]
      .filter(Boolean)
      .join(' ') || null;
    os = [parsed.os.name, parsed.os.version].filter(Boolean).join(' ') || null;
  }

  return { ip, userAgent, device, browser, os };
}

/** For server components and server actions. */
export async function requestContext(): Promise<RequestContext> {
  return contextFromHeaders(await headers());
}

/** Short, human-friendly description of a session's origin. */
export function describeDevice(input: {
  browser?: string | null;
  os?: string | null;
  device?: string | null;
}): string {
  const parts = [input.browser, input.os].filter(Boolean);
  if (parts.length === 0) return input.device || 'Unknown device';
  return parts.join(' · ');
}
