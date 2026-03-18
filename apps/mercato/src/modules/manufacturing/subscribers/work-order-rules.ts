import type { EntityManager, FilterQuery } from '@mikro-orm/postgresql'
import { executeRules, type RuleEngineContext } from '@open-mercato/core'
import { WorkOrder } from '../data/entities'

export const metadata = {
  event: 'manufacturing.work_order.updated',
  persistent: true,
  id: 'manufacturing:work-order-updated-rules',
}

export async function runWorkOrderRules(
  payload: { id: string; tenantId: string; organizationId: string },
  ctx: { resolve: <T = unknown>(name: string) => T },
  eventType: string,
) {
  const em = ctx.resolve<EntityManager>('em')

  const workOrder = await em.findOne(WorkOrder, {
    id: payload.id,
    tenantId: payload.tenantId,
    organizationId: payload.organizationId,
    deletedAt: null,
  } as FilterQuery<WorkOrder>)

  if (!workOrder) return

  const context: RuleEngineContext = {
    entityType: 'WorkOrder',
    entityId: workOrder.id,
    eventType,
    data: {
      id: workOrder.id,
      wo_number: workOrder.woNumber,
      status: workOrder.status,
      customer_entity_id: workOrder.customerEntityId ?? null,
      customer_name: workOrder.customerName ?? null,
      industry: workOrder.industry ?? null,
      priority: workOrder.priority,
      material: workOrder.material ?? null,
      quantity: workOrder.quantity ?? null,
      due_date: workOrder.dueDate ?? null,
      materials_available: workOrder.materialsAvailable,
    },
    tenantId: payload.tenantId,
    organizationId: payload.organizationId,
  }

  await executeRules(em, context)
}

export default async function handler(
  payload: { id: string; tenantId: string; organizationId: string },
  ctx: { resolve: <T = unknown>(name: string) => T },
) {
  await runWorkOrderRules(payload, ctx, 'afterUpdate')
}
