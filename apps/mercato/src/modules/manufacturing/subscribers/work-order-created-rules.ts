import { runWorkOrderRules } from './work-order-rules'

export const metadata = {
  event: 'manufacturing.work_order.created',
  persistent: true,
  id: 'manufacturing:work-order-created-rules',
}

export default async function handler(
  payload: { id: string; tenantId: string; organizationId: string },
  ctx: { resolve: <T = unknown>(name: string) => T },
) {
  await runWorkOrderRules(payload, ctx, 'afterCreate')
}
