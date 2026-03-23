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
import { InspectionRecord } from '../data/entities'
import { inspectionCreateSchema, inspectionUpdateSchema } from '../data/validators'
import { E } from '@/.mercato/generated/entities.ids.generated'

type SerializedInspection = {
  id: string
  inspection_number: string
  work_order_ref: string | null
  inspector_name: string | null
  result: string | null
  defect_description: string | null
  inspection_date: string | null
  tenantId: string | null
  organizationId: string | null
}

export const inspectionCrudEvents: CrudEventsConfig = {
  module: 'manufacturing',
  entity: 'inspection_record',
  persistent: true,
  buildPayload: (ctx: CrudEmitContext) => {
    const entity = ctx.entity as InspectionRecord | undefined
    return {
      id: ctx.identifiers.id,
      tenantId: ctx.identifiers.tenantId,
      organizationId: ctx.identifiers.organizationId,
      inspectionNumber: entity?.inspectionNumber ?? null,
      workOrderRef: entity?.workOrderRef ?? null,
      inspectorName: entity?.inspectorName ?? null,
      result: entity?.result ?? null,
      defectDescription: entity?.defectDescription ?? null,
      inspectionDate: entity?.inspectionDate ?? null,
    }
  },
}

export const inspectionCrudIndexer: CrudIndexerConfig = {
  entityType: E.manufacturing.inspection_record,
  buildUpsertPayload: (ctx: CrudEmitContext) => ({
    entityType: E.manufacturing.inspection_record,
    recordId: ctx.identifiers.id,
    tenantId: ctx.identifiers.tenantId,
    organizationId: ctx.identifiers.organizationId,
  }),
  buildDeletePayload: (ctx: CrudEmitContext) => ({
    entityType: E.manufacturing.inspection_record,
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

function serializeInspection(rec: InspectionRecord): SerializedInspection {
  return {
    id: String(rec.id),
    inspection_number: String(rec.inspectionNumber),
    work_order_ref: rec.workOrderRef ?? null,
    inspector_name: rec.inspectorName ?? null,
    result: rec.result ?? null,
    defect_description: rec.defectDescription ?? null,
    inspection_date: rec.inspectionDate ?? null,
    tenantId: rec.tenantId ? String(rec.tenantId) : null,
    organizationId: rec.organizationId ? String(rec.organizationId) : null,
  }
}

const createCommand: CommandHandler<Record<string, unknown>, InspectionRecord> = {
  id: 'manufacturing.inspections.create',
  isUndoable: true,
  async execute(rawInput, ctx) {
    const { parsed } = parseWithCustomFields(inspectionCreateSchema, rawInput)
    const scope = ensureScope(ctx)
    const de = ctx.container.resolve('dataEngine') as DataEngine

    const rec = await de.createOrmEntity({
      entity: InspectionRecord,
      data: {
        inspectionNumber: parsed.inspection_number,
        workOrderRef: parsed.work_order_ref ?? null,
        inspectorName: parsed.inspector_name ?? null,
        result: parsed.result ?? null,
        defectDescription: parsed.defect_description ?? null,
        inspectionDate: parsed.inspection_date ?? null,
        tenantId: scope.tenantId,
        organizationId: scope.organizationId,
      },
    })

    await emitCrudSideEffects({
      dataEngine: de, action: 'created', entity: rec,
      identifiers: { id: String(rec.id), tenantId: scope.tenantId, organizationId: scope.organizationId },
      events: inspectionCrudEvents, indexer: inspectionCrudIndexer,
    })

    return rec
  },
  captureAfter: (_input, result) => serializeInspection(result),
  buildLog: async ({ result }) => {
    const { translate } = await resolveTranslations()
    return {
      actionLabel: translate('manufacturing.audit.inspection.create', 'Create inspection record'),
      resourceKind: 'manufacturing.inspection_record',
      resourceId: String(result.id),
      tenantId: result.tenantId ? String(result.tenantId) : null,
      organizationId: result.organizationId ? String(result.organizationId) : null,
      snapshotAfter: serializeInspection(result),
    }
  },
  async undo({ logEntry, ctx }) {
    const snapshot = logEntry.snapshotAfter as SerializedInspection | undefined
    const id = snapshot?.id ?? logEntry.resourceId
    if (!id) throw new Error('Missing inspection id for undo')
    const scope = resolveUndoScope(ctx, snapshot)
    const de = ctx.container.resolve('dataEngine') as DataEngine
    const removed = await de.deleteOrmEntity({
      entity: InspectionRecord,
      where: { id, tenantId: scope.tenantId, organizationId: scope.organizationId } as FilterQuery<InspectionRecord>,
      soft: true, softDeleteField: 'deletedAt',
    })
    await emitCrudUndoSideEffects({
      dataEngine: de, action: 'deleted', entity: removed,
      identifiers: { id, tenantId: scope.tenantId, organizationId: scope.organizationId },
      events: inspectionCrudEvents, indexer: inspectionCrudIndexer,
    })
  },
}

const updateCommand: CommandHandler<Record<string, unknown>, InspectionRecord> = {
  id: 'manufacturing.inspections.update',
  isUndoable: true,
  async prepare(rawInput, ctx) {
    const { parsed } = parseWithCustomFields(inspectionUpdateSchema, rawInput)
    const em = ctx.container.resolve('em') as EntityManager
    const existing = await em.findOne(InspectionRecord, { id: parsed.id, deletedAt: null } as FilterQuery<InspectionRecord>)
    if (!existing) throw new CrudHttpError(404, { error: 'Inspection record not found' })
    return { before: serializeInspection(existing) }
  },
  async execute(rawInput, ctx) {
    const { parsed } = parseWithCustomFields(inspectionUpdateSchema, rawInput)
    const scope = ensureScope(ctx)
    const de = ctx.container.resolve('dataEngine') as DataEngine

    const rec = await de.updateOrmEntity({
      entity: InspectionRecord,
      where: { id: parsed.id, tenantId: scope.tenantId, organizationId: scope.organizationId, deletedAt: null } as FilterQuery<InspectionRecord>,
      apply: (entity) => {
        if (parsed.inspection_number !== undefined) entity.inspectionNumber = parsed.inspection_number
        if (parsed.work_order_ref !== undefined) entity.workOrderRef = parsed.work_order_ref ?? null
        if (parsed.inspector_name !== undefined) entity.inspectorName = parsed.inspector_name ?? null
        if (parsed.result !== undefined) entity.result = parsed.result ?? null
        if (parsed.defect_description !== undefined) entity.defectDescription = parsed.defect_description ?? null
        if (parsed.inspection_date !== undefined) entity.inspectionDate = parsed.inspection_date ?? null
      },
    })
    if (!rec) throw new CrudHttpError(404, { error: 'Inspection record not found' })

    await emitCrudSideEffects({
      dataEngine: de, action: 'updated', entity: rec,
      identifiers: { id: String(rec.id), tenantId: scope.tenantId, organizationId: scope.organizationId },
      events: inspectionCrudEvents, indexer: inspectionCrudIndexer,
    })

    return rec
  },
  captureAfter: (_input, result) => serializeInspection(result),
  buildLog: async ({ result, snapshots }) => {
    const { translate } = await resolveTranslations()
    const before = snapshots.before as SerializedInspection | undefined
    const after = serializeInspection(result)
    const changes = buildChanges(before ?? null, after as unknown as Record<string, unknown>, [
      'inspection_number', 'work_order_ref', 'inspector_name', 'result', 'defect_description', 'inspection_date',
    ])
    return {
      actionLabel: translate('manufacturing.audit.inspection.update', 'Update inspection record'),
      resourceKind: 'manufacturing.inspection_record',
      resourceId: String(result.id),
      tenantId: result.tenantId ? String(result.tenantId) : null,
      organizationId: result.organizationId ? String(result.organizationId) : null,
      changes, snapshotBefore: before ?? null, snapshotAfter: after,
    }
  },
  async undo({ logEntry, ctx }) {
    const before = logEntry.snapshotBefore as SerializedInspection | undefined
    if (!before?.id) throw new Error('Missing previous snapshot for undo')
    const scope = resolveUndoScope(ctx, before)
    const de = ctx.container.resolve('dataEngine') as DataEngine
    await de.updateOrmEntity({
      entity: InspectionRecord,
      where: { id: before.id, tenantId: scope.tenantId, organizationId: scope.organizationId, deletedAt: null } as FilterQuery<InspectionRecord>,
      apply: (entity) => {
        entity.inspectionNumber = before.inspection_number
        entity.workOrderRef = before.work_order_ref
        entity.inspectorName = before.inspector_name
        entity.result = before.result
        entity.defectDescription = before.defect_description
        entity.inspectionDate = before.inspection_date
      },
    })
    await emitCrudUndoSideEffects({
      dataEngine: de, action: 'updated', entity: null,
      identifiers: { id: before.id, tenantId: scope.tenantId, organizationId: scope.organizationId },
      events: inspectionCrudEvents, indexer: inspectionCrudIndexer,
    })
  },
}

const deleteCommand: CommandHandler<{ body?: Record<string, unknown>; query?: Record<string, unknown> }, InspectionRecord> = {
  id: 'manufacturing.inspections.delete',
  isUndoable: true,
  async prepare(input, ctx) {
    const id = requireId(input, 'Inspection id required')
    const em = ctx.container.resolve('em') as EntityManager
    const existing = await em.findOne(InspectionRecord, { id, deletedAt: null } as FilterQuery<InspectionRecord>)
    if (!existing) return {}
    return { before: serializeInspection(existing) }
  },
  async execute(input, ctx) {
    const id = requireId(input, 'Inspection id required')
    const scope = ensureScope(ctx)
    const de = ctx.container.resolve('dataEngine') as DataEngine
    const rec = await de.deleteOrmEntity({
      entity: InspectionRecord,
      where: { id, tenantId: scope.tenantId, organizationId: scope.organizationId, deletedAt: null } as FilterQuery<InspectionRecord>,
      soft: true, softDeleteField: 'deletedAt',
    })
    if (!rec) throw new CrudHttpError(404, { error: 'Inspection record not found' })

    await emitCrudSideEffects({
      dataEngine: de, action: 'deleted', entity: rec,
      identifiers: { id, tenantId: scope.tenantId, organizationId: scope.organizationId },
      events: inspectionCrudEvents, indexer: inspectionCrudIndexer,
    })
    return rec
  },
  buildLog: async ({ snapshots, input }) => {
    const { translate } = await resolveTranslations()
    const before = snapshots.before as SerializedInspection | undefined
    const id = requireId(input, 'Inspection id required')
    return {
      actionLabel: translate('manufacturing.audit.inspection.delete', 'Delete inspection record'),
      resourceKind: 'manufacturing.inspection_record',
      resourceId: id,
      tenantId: before?.tenantId ?? null,
      organizationId: before?.organizationId ?? null,
      snapshotBefore: before ?? null,
    }
  },
  async undo({ logEntry, ctx }) {
    const before = logEntry.snapshotBefore as SerializedInspection | undefined
    if (!before?.id) throw new Error('Missing snapshot for undo')
    const scope = resolveUndoScope(ctx, before)
    const em = ctx.container.resolve('em') as EntityManager
    const de = ctx.container.resolve('dataEngine') as DataEngine
    let restored = await em.findOne(InspectionRecord, { id: before.id, tenantId: scope.tenantId, organizationId: scope.organizationId } as FilterQuery<InspectionRecord>)
    if (restored) {
      restored.deletedAt = null
      restored.inspectionNumber = before.inspection_number
      restored.workOrderRef = before.work_order_ref
      restored.inspectorName = before.inspector_name
      restored.result = before.result
      restored.defectDescription = before.defect_description
      restored.inspectionDate = before.inspection_date
      await em.persistAndFlush(restored)
    } else {
      restored = await de.createOrmEntity({
        entity: InspectionRecord,
        data: {
          id: before.id, inspectionNumber: before.inspection_number, workOrderRef: before.work_order_ref,
          inspectorName: before.inspector_name, result: before.result, defectDescription: before.defect_description,
          inspectionDate: before.inspection_date, tenantId: scope.tenantId, organizationId: scope.organizationId,
        },
      })
    }
    await emitCrudUndoSideEffects({
      dataEngine: de, action: 'updated', entity: restored,
      identifiers: { id: before.id, tenantId: scope.tenantId, organizationId: scope.organizationId },
      events: inspectionCrudEvents, indexer: inspectionCrudIndexer,
    })
  },
}

registerCommand(createCommand)
registerCommand(updateCommand)
registerCommand(deleteCommand)
