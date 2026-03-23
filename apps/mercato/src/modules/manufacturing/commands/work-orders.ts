import type { CommandHandler } from '@open-mercato/shared/lib/commands'
import { registerCommand } from '@open-mercato/shared/lib/commands'
import {
  parseWithCustomFields,
  emitCrudSideEffects,
  emitCrudUndoSideEffects,
  buildChanges,
  requireId,
} from '@open-mercato/shared/lib/commands/helpers'
import type { CrudEmitContext, CrudEventsConfig, CrudIndexerConfig } from '@open-mercato/shared/lib/crud/types'
import { CrudHttpError } from '@open-mercato/shared/lib/crud/errors'
import type { DataEngine } from '@open-mercato/shared/lib/data/engine'
import type { EntityManager, FilterQuery } from '@mikro-orm/postgresql'
import { resolveTranslations } from '@open-mercato/shared/lib/i18n/server'
import type { CommandRuntimeContext } from '@open-mercato/shared/lib/commands'
import { WorkOrder } from '../data/entities'
import { workOrderCreateSchema, workOrderUpdateSchema } from '../data/validators'
import { E } from '@/.mercato/generated/entities.ids.generated'

type SerializedWorkOrder = {
  id: string
  wo_number: string
  status: string
  customer_entity_id: string | null
  customer_name: string | null
  industry: string | null
  priority: string
  material: string | null
  quantity: number | null
  due_date: string | null
  materials_available: boolean
  notes: string | null
  tenantId: string | null
  organizationId: string | null
}

export const workOrderCrudEvents: CrudEventsConfig = {
  module: 'manufacturing',
  entity: 'work_order',
  persistent: true,
  buildPayload: (ctx: CrudEmitContext) => {
    const entity = ctx.entity as WorkOrder | undefined
    return {
      id: ctx.identifiers.id,
      tenantId: ctx.identifiers.tenantId,
      organizationId: ctx.identifiers.organizationId,
      woNumber: entity?.woNumber ?? null,
      status: entity?.status ?? null,
      priority: entity?.priority ?? null,
      industry: entity?.industry ?? null,
      material: entity?.material ?? null,
      quantity: entity?.quantity ?? null,
      customerName: entity?.customerName ?? null,
      customerEntityId: entity?.customerEntityId ?? null,
      materialsAvailable: entity?.materialsAvailable ?? null,
      dueDate: entity?.dueDate ?? null,
    }
  },
}

export const workOrderCrudIndexer: CrudIndexerConfig = {
  entityType: E.manufacturing.work_order,
  buildUpsertPayload: (ctx: CrudEmitContext) => ({
    entityType: E.manufacturing.work_order,
    recordId: ctx.identifiers.id,
    tenantId: ctx.identifiers.tenantId,
    organizationId: ctx.identifiers.organizationId,
  }),
  buildDeletePayload: (ctx: CrudEmitContext) => ({
    entityType: E.manufacturing.work_order,
    recordId: ctx.identifiers.id,
    tenantId: ctx.identifiers.tenantId,
    organizationId: ctx.identifiers.organizationId,
  }),
}

function ensureScope(ctx: CommandRuntimeContext): { tenantId: string; organizationId: string } {
  const tenantId = ctx.auth?.tenantId ?? null
  if (!tenantId) throw new CrudHttpError(400, { error: 'Tenant context is required' })
  const organizationId = ctx.selectedOrganizationId ?? ctx.auth?.orgId ?? null
  if (!organizationId) throw new CrudHttpError(400, { error: 'Organization context is required' })
  return { tenantId, organizationId }
}

function resolveUndoScope(
  ctx: CommandRuntimeContext,
  snapshot?: { tenantId: string | null; organizationId: string | null },
): { tenantId: string; organizationId: string } {
  const scope = ensureScope(ctx)
  const tenantId = snapshot?.tenantId ?? scope.tenantId
  if (tenantId !== scope.tenantId) throw new CrudHttpError(403, { error: 'Undo scope does not match tenant' })
  let organizationId = scope.organizationId
  if (snapshot?.organizationId) {
    const allowed = Array.isArray(ctx.organizationIds) ? ctx.organizationIds : null
    if (allowed && allowed.length > 0 && !allowed.includes(snapshot.organizationId)) {
      throw new CrudHttpError(403, { error: 'Undo scope is not permitted for this organization' })
    }
    organizationId = snapshot.organizationId
  }
  return { tenantId, organizationId }
}

function serializeWorkOrder(wo: WorkOrder): SerializedWorkOrder {
  return {
    id: String(wo.id),
    wo_number: String(wo.woNumber),
    status: String(wo.status),
    customer_entity_id: wo.customerEntityId ?? null,
    customer_name: wo.customerName ?? null,
    industry: wo.industry ?? null,
    priority: String(wo.priority),
    material: wo.material ?? null,
    quantity: wo.quantity ?? null,
    due_date: wo.dueDate ?? null,
    materials_available: !!wo.materialsAvailable,
    notes: wo.notes ?? null,
    tenantId: wo.tenantId ? String(wo.tenantId) : null,
    organizationId: wo.organizationId ? String(wo.organizationId) : null,
  }
}

const createCommand: CommandHandler<Record<string, unknown>, WorkOrder> = {
  id: 'manufacturing.work_orders.create',
  isUndoable: true,
  async execute(rawInput, ctx) {
    const { parsed } = parseWithCustomFields(workOrderCreateSchema, rawInput)
    const scope = ensureScope(ctx)
    const de = ctx.container.resolve('dataEngine') as DataEngine
    const em = ctx.container.resolve('em') as EntityManager

    let customerName = parsed.customer_name ?? null
    const customerEntityId = parsed.customer_entity_id ?? null
    if (customerEntityId && !customerName) {
      const customer = await em.findOne('CustomerEntity' as never, { id: customerEntityId } as FilterQuery<never>)
      if (customer) customerName = (customer as { displayName?: string }).displayName ?? null
    }

    const wo = await de.createOrmEntity({
      entity: WorkOrder,
      data: {
        woNumber: parsed.wo_number,
        status: parsed.status ?? 'DRAFT',
        customerEntityId,
        customerName,
        industry: parsed.industry ?? null,
        priority: parsed.priority ?? 'NORMAL',
        material: parsed.material ?? null,
        quantity: parsed.quantity ?? null,
        dueDate: parsed.due_date ?? null,
        materialsAvailable: parsed.materials_available ?? false,
        notes: parsed.notes ?? null,
        tenantId: scope.tenantId,
        organizationId: scope.organizationId,
      },
    })

    await emitCrudSideEffects({
      dataEngine: de,
      action: 'created',
      entity: wo,
      identifiers: { id: String(wo.id), tenantId: scope.tenantId, organizationId: scope.organizationId },
      events: workOrderCrudEvents,
      indexer: workOrderCrudIndexer,
    })

    return wo
  },
  captureAfter: (_input, result) => serializeWorkOrder(result),
  buildLog: async ({ result }) => {
    const { translate } = await resolveTranslations()
    return {
      actionLabel: translate('manufacturing.audit.work_order.create', 'Create work order'),
      resourceKind: 'manufacturing.work_order',
      resourceId: String(result.id),
      tenantId: result.tenantId ? String(result.tenantId) : null,
      organizationId: result.organizationId ? String(result.organizationId) : null,
      snapshotAfter: serializeWorkOrder(result),
    }
  },
  async undo({ logEntry, ctx }) {
    const snapshot = logEntry.snapshotAfter as SerializedWorkOrder | undefined
    const id = snapshot?.id ?? logEntry.resourceId
    if (!id) throw new Error('Missing work order id for undo')
    const scope = resolveUndoScope(ctx, snapshot)
    const de = ctx.container.resolve('dataEngine') as DataEngine
    const removed = await de.deleteOrmEntity({
      entity: WorkOrder,
      where: { id, tenantId: scope.tenantId, organizationId: scope.organizationId } as FilterQuery<WorkOrder>,
      soft: true,
      softDeleteField: 'deletedAt',
    })
    await emitCrudUndoSideEffects({
      dataEngine: de, action: 'deleted', entity: removed,
      identifiers: { id, tenantId: scope.tenantId, organizationId: scope.organizationId },
      events: workOrderCrudEvents, indexer: workOrderCrudIndexer,
    })
  },
}

const updateCommand: CommandHandler<Record<string, unknown>, WorkOrder> = {
  id: 'manufacturing.work_orders.update',
  isUndoable: true,
  async prepare(rawInput, ctx) {
    const { parsed } = parseWithCustomFields(workOrderUpdateSchema, rawInput)
    const em = ctx.container.resolve('em') as EntityManager
    const existing = await em.findOne(WorkOrder, { id: parsed.id, deletedAt: null } as FilterQuery<WorkOrder>)
    if (!existing) throw new CrudHttpError(404, { error: 'Work order not found' })
    return { before: serializeWorkOrder(existing) }
  },
  async execute(rawInput, ctx) {
    const { parsed } = parseWithCustomFields(workOrderUpdateSchema, rawInput)
    const scope = ensureScope(ctx)
    const de = ctx.container.resolve('dataEngine') as DataEngine

    const em = ctx.container.resolve('em') as EntityManager
    if (parsed.customer_entity_id !== undefined) {
      const newCustId = parsed.customer_entity_id ?? null
      if (newCustId && parsed.customer_name === undefined) {
        const customer = await em.findOne('CustomerEntity' as never, { id: newCustId } as FilterQuery<never>)
        if (customer) parsed.customer_name = (customer as { displayName?: string }).displayName ?? null
      }
    }

    const wo = await de.updateOrmEntity({
      entity: WorkOrder,
      where: { id: parsed.id, tenantId: scope.tenantId, organizationId: scope.organizationId, deletedAt: null } as FilterQuery<WorkOrder>,
      apply: (entity) => {
        if (parsed.wo_number !== undefined) entity.woNumber = parsed.wo_number
        if (parsed.status !== undefined) entity.status = parsed.status
        if (parsed.customer_entity_id !== undefined) entity.customerEntityId = parsed.customer_entity_id ?? null
        if (parsed.customer_name !== undefined) entity.customerName = parsed.customer_name ?? null
        if (parsed.industry !== undefined) entity.industry = parsed.industry ?? null
        if (parsed.priority !== undefined) entity.priority = parsed.priority
        if (parsed.material !== undefined) entity.material = parsed.material ?? null
        if (parsed.quantity !== undefined) entity.quantity = parsed.quantity ?? null
        if (parsed.due_date !== undefined) entity.dueDate = parsed.due_date ?? null
        if (parsed.materials_available !== undefined) entity.materialsAvailable = parsed.materials_available
        if (parsed.notes !== undefined) entity.notes = parsed.notes ?? null
      },
    })
    if (!wo) throw new CrudHttpError(404, { error: 'Work order not found' })

    await emitCrudSideEffects({
      dataEngine: de, action: 'updated', entity: wo,
      identifiers: { id: String(wo.id), tenantId: scope.tenantId, organizationId: scope.organizationId },
      events: workOrderCrudEvents, indexer: workOrderCrudIndexer,
    })

    return wo
  },
  captureAfter: (_input, result) => serializeWorkOrder(result),
  buildLog: async ({ result, snapshots }) => {
    const { translate } = await resolveTranslations()
    const before = snapshots.before as SerializedWorkOrder | undefined
    const after = serializeWorkOrder(result)
    const changes = buildChanges(before ?? null, after as unknown as Record<string, unknown>, [
      'wo_number', 'status', 'customer_entity_id', 'customer_name', 'industry', 'priority', 'material', 'quantity', 'due_date', 'materials_available', 'notes',
    ])
    return {
      actionLabel: translate('manufacturing.audit.work_order.update', 'Update work order'),
      resourceKind: 'manufacturing.work_order',
      resourceId: String(result.id),
      tenantId: result.tenantId ? String(result.tenantId) : null,
      organizationId: result.organizationId ? String(result.organizationId) : null,
      changes, snapshotBefore: before ?? null, snapshotAfter: after,
    }
  },
  async undo({ logEntry, ctx }) {
    const before = logEntry.snapshotBefore as SerializedWorkOrder | undefined
    if (!before?.id) throw new Error('Missing previous snapshot for undo')
    const scope = resolveUndoScope(ctx, before)
    const de = ctx.container.resolve('dataEngine') as DataEngine
    await de.updateOrmEntity({
      entity: WorkOrder,
      where: { id: before.id, tenantId: scope.tenantId, organizationId: scope.organizationId, deletedAt: null } as FilterQuery<WorkOrder>,
      apply: (entity) => {
        entity.woNumber = before.wo_number
        entity.status = before.status
        entity.customerEntityId = before.customer_entity_id
        entity.customerName = before.customer_name
        entity.industry = before.industry
        entity.priority = before.priority
        entity.material = before.material
        entity.quantity = before.quantity
        entity.dueDate = before.due_date
        entity.materialsAvailable = before.materials_available
        entity.notes = before.notes
      },
    })
    await emitCrudUndoSideEffects({
      dataEngine: de, action: 'updated', entity: null,
      identifiers: { id: before.id, tenantId: scope.tenantId, organizationId: scope.organizationId },
      events: workOrderCrudEvents, indexer: workOrderCrudIndexer,
    })
  },
}

const deleteCommand: CommandHandler<{ body?: Record<string, unknown>; query?: Record<string, unknown> }, WorkOrder> = {
  id: 'manufacturing.work_orders.delete',
  isUndoable: true,
  async prepare(input, ctx) {
    const id = requireId(input, 'Work order id required')
    const em = ctx.container.resolve('em') as EntityManager
    const existing = await em.findOne(WorkOrder, { id, deletedAt: null } as FilterQuery<WorkOrder>)
    if (!existing) return {}
    return { before: serializeWorkOrder(existing) }
  },
  async execute(input, ctx) {
    const id = requireId(input, 'Work order id required')
    const scope = ensureScope(ctx)
    const de = ctx.container.resolve('dataEngine') as DataEngine
    const wo = await de.deleteOrmEntity({
      entity: WorkOrder,
      where: { id, tenantId: scope.tenantId, organizationId: scope.organizationId, deletedAt: null } as FilterQuery<WorkOrder>,
      soft: true, softDeleteField: 'deletedAt',
    })
    if (!wo) throw new CrudHttpError(404, { error: 'Work order not found' })

    await emitCrudSideEffects({
      dataEngine: de, action: 'deleted', entity: wo,
      identifiers: { id, tenantId: scope.tenantId, organizationId: scope.organizationId },
      events: workOrderCrudEvents, indexer: workOrderCrudIndexer,
    })
    return wo
  },
  buildLog: async ({ snapshots, input }) => {
    const { translate } = await resolveTranslations()
    const before = snapshots.before as SerializedWorkOrder | undefined
    const id = requireId(input, 'Work order id required')
    return {
      actionLabel: translate('manufacturing.audit.work_order.delete', 'Delete work order'),
      resourceKind: 'manufacturing.work_order',
      resourceId: id,
      tenantId: before?.tenantId ?? null,
      organizationId: before?.organizationId ?? null,
      snapshotBefore: before ?? null,
    }
  },
  async undo({ logEntry, ctx }) {
    const before = logEntry.snapshotBefore as SerializedWorkOrder | undefined
    if (!before?.id) throw new Error('Missing snapshot for undo')
    const scope = resolveUndoScope(ctx, before)
    const em = ctx.container.resolve('em') as EntityManager
    const de = ctx.container.resolve('dataEngine') as DataEngine
    let restored = await em.findOne(WorkOrder, { id: before.id, tenantId: scope.tenantId, organizationId: scope.organizationId } as FilterQuery<WorkOrder>)
    if (restored) {
      restored.deletedAt = null
      restored.woNumber = before.wo_number
      restored.status = before.status
      restored.customerEntityId = before.customer_entity_id
      restored.customerName = before.customer_name
      restored.industry = before.industry
      restored.priority = before.priority
      restored.material = before.material
      restored.quantity = before.quantity
      restored.dueDate = before.due_date
      restored.materialsAvailable = before.materials_available
      restored.notes = before.notes
      await em.persistAndFlush(restored)
    } else {
      restored = await de.createOrmEntity({
        entity: WorkOrder,
        data: {
          id: before.id, woNumber: before.wo_number, status: before.status, customerEntityId: before.customer_entity_id, customerName: before.customer_name,
          industry: before.industry, priority: before.priority, material: before.material, quantity: before.quantity,
          dueDate: before.due_date, materialsAvailable: before.materials_available, notes: before.notes,
          tenantId: scope.tenantId, organizationId: scope.organizationId,
        },
      })
    }
    await emitCrudUndoSideEffects({
      dataEngine: de, action: 'updated', entity: restored,
      identifiers: { id: before.id, tenantId: scope.tenantId, organizationId: scope.organizationId },
      events: workOrderCrudEvents, indexer: workOrderCrudIndexer,
    })
  },
}

registerCommand(createCommand)
registerCommand(updateCommand)
registerCommand(deleteCommand)
