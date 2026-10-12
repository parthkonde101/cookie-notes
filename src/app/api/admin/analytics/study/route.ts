import { NextResponse, type NextRequest } from 'next/server';
import { toErrorResponse } from '@/lib/errors';
import { requireApiAdmin } from '@/lib/auth/guards';
import {
  activeByMonth,
  parseCustom,
  parseMonths,
  parseOffset,
  parseRange,
  registrationsByMonth,
  studyHours,
  studySubjects,
} from '@/lib/analytics/study';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Data for the two study charts on the admin overview, one period at a time.
 *
 *   GET /api/admin/analytics/study?chart=hours|subjects&range=day|week|month&offset=0
 *   GET /api/admin/analytics/study?chart=hours|subjects&range=custom&from=YYYY-MM-DD&to=YYYY-MM-DD
 *   GET /api/admin/analytics/study?chart=active|registrations&months=6|12|24
 *
 * `offset` counts periods back from the current one (0 is now, -1 the one
 * before). A custom span is any run of days up to a year, never into the future;
 * one date in both ends is that single day. Anything that is not a real date
 * falls back to today. Admin only — anyone else gets the same 404 as any admin route — and
 * never cached. Only counts are returned: no student is named.
 */
export async function GET(request: NextRequest) {
  try {
    await requireApiAdmin();

    const params = request.nextUrl.searchParams;

    // Month by month: students using the notes, and registrations.
    if (params.get('chart') === 'active' || params.get('chart') === 'registrations') {
      const months = parseMonths(params.get('months'));
      const monthly = params.get('chart') === 'active' ? await activeByMonth(months) : await registrationsByMonth(months);
      return NextResponse.json(monthly, { headers: { 'Cache-Control': 'no-store' } });
    }

    const custom = parseCustom(params.get('from'), params.get('to'));
    // A custom span needs both dates; without them it is just today.
    const range = parseRange(params.get('range')) === 'custom' && !custom ? 'day' : parseRange(params.get('range'));
    const offset = parseOffset(params.get('offset'));
    const result =
      params.get('chart') === 'subjects'
        ? await studySubjects(range, offset, custom)
        : await studyHours(range, offset, custom);

    return NextResponse.json(result, { headers: { 'Cache-Control': 'no-store' } });
  } catch (error) {
    return toErrorResponse(error);
  }
}
