import type { SyncCrudEventPayload, SyncCrudEventResult } from '@open-mercato/shared/lib/crud/sync-event-types'
import type { EntityManager } from '@mikro-orm/postgresql'
import { executeRules, type RuleEngineContext } from '@open-mercato/core/modules/business_rules'

/**
 * Sync before-update subscriber: runs business rules engine with
 * entityType 'WorkOrder' and eventType 'beforeUpdate'.
 *
 * GUARD-type rules (e.g. "block release without materials") will
 * cause allowed=false, rejecting the update with 422.
 */
export const metadata = {
  event: 'manufacturing.work_order.updating',
  sync: true,
  priority: 50,
  id: 'manufacturing:work-order-before-update-rules',
}

export default async function handler(
  payload: SyncCrudEventPayload,
  ctx: { resolve: <T = unknown>(name: string) => T },
): Promise<SyncCrudEventResult | void> {
  const body = payload.payload
  if (!body || typeof body !== 'object') return

  const em = ctx.resolve<EntityManager>('em')

  const merged = { ...payload.previousData, ...body }

  const context: RuleEngineContext = {
    entityType: 'WorkOrder',
    entityId: payload.resourceId ?? undefined,
    eventType: 'beforeUpdate',
    data: {
      id: payload.resourceId,
      wo_number: merged.wo_number ?? merged.woNumber,
      status: merged.status,
      customer_entity_id: merged.customer_entity_id ?? merged.customerEntityId ?? null,
      customer_name: merged.customer_name ?? merged.customerName ?? null,
      industry: merged.industry ?? null,
      priority: merged.priority,
      material: merged.material ?? null,
      quantity: merged.quantity ?? null,
      due_date: merged.due_date ?? merged.dueDate ?? null,
      materials_available: merged.materials_available ?? merged.materialsAvailable ?? false,
    },
    tenantId: payload.tenantId ?? '',
    organizationId: payload.organizationId ?? '',
  }

  const result = await executeRules(em, context)

  // GUARD rules: conditionResult=true means the "block" condition matched
  // The engine sets allowed=false when NOT all guard conditions pass,
  // but the business intent is: condition=true → block the operation.
  const guardResults = result.executedRules.filter(r => r.rule?.ruleType === 'GUARD')
  const blocked = guardResults.some(r => r.conditionResult)

  if (blocked) {
    const messages = guardResults
      .filter(r => r.conditionResult)
      .map(r => r.rule?.ruleName ?? r.error ?? 'Rule blocked')
    return {
      ok: false,
      message: messages.join('; ') || 'Blocked by business rules',
      status: 422,
    }
  }
}
