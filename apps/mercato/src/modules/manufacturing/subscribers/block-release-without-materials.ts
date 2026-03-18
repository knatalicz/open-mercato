import type { SyncCrudEventPayload, SyncCrudEventResult } from '@open-mercato/shared/lib/crud/sync-event-types'

/**
 * Sync before-update subscriber: prevents releasing a work order when
 * materials have not been confirmed as available.
 *
 * Required for AS 9100 material traceability compliance.
 */
export const metadata = {
  event: 'manufacturing.work_order.updating',
  sync: true,
  priority: 50,
  id: 'manufacturing:block-release-without-materials',
}

export default async function handler(
  payload: SyncCrudEventPayload,
): Promise<SyncCrudEventResult | void> {
  const body = payload.payload
  if (!body || typeof body !== 'object') return

  const newStatus = ('status' in body ? body.status : undefined) as string | undefined
  if (newStatus !== 'RELEASED') return

  const materialsAvailable =
    ('materials_available' in body ? body.materials_available : undefined) ??
    payload.previousData?.materials_available ??
    payload.previousData?.materialsAvailable

  if (!materialsAvailable) {
    return {
      ok: false,
      message: 'Cannot release work order to production: materials have not been confirmed as available (AS 9100 requirement)',
      status: 422,
    }
  }
}
