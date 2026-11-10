import type {
  Attributes,
  Histogram,
  HrTime,
  Span,
  SpanContext,
} from '@opentelemetry/api'
import type { TraceEvent } from './types'

// Accounting bounds for centrally retained metadata and UTF-16 snapshots, not
// exact heap limits. Local traces, caller-held context tokens and SDK memory are
// independent. Reserve one slot and 512 bytes for the explicitly captured root.
export const REPLAY_EVENT_LIMIT = 10_000
export const REPLAY_BYTE_LIMIT = 8 * 1024 * 1024
const ROOT_BYTES = 512

export type ReportingRecord = {
  id: number
  parentId?: number
  name: string
  // Epoch nanoseconds, derived from the shared monotonic clock offset.
  start: bigint
  end?: bigint
  failed?: boolean
  encoded?: string
  parent?: ReportingRecord
  span?: Span
  context?: SpanContext
  retained: boolean
  size: number
  generation: number
}

let state: 'unregistered' | 'ready' | 'closed' = 'unregistered'
// Local-only producers never load this application-owned Next tracer backend.
let backend: typeof import('../server/lib/trace/otel-api') | undefined
let generation = 0
let suppressed = false
let warned = false
let retainedBytes = 0
let defaultParent: ReportingRecord | undefined
// SDK callbacks may capture/end spans or reset/close the session. Finish such
// captures after the active SDK call returns, without recursively entering it.
let reporting = false
let reentered = false
const records = new Set<ReportingRecord>()
// Compiler workers allocate IDs independently. They share retention accounting,
// but must not replace coordinator records used for numeric parent lookup.
const coordinatorRecords = new Map<number, ReportingRecord>()
const histograms = new Map<string, Histogram>()

function reportMeasurements(record: ReportingRecord): boolean {
  const memory = record.name === 'memory-usage'
  const restart = record.name === 'server-restart-close-to-memory-threshold'
  const native =
    record.name === 'turbopack-persistence' ||
    record.name === 'turbopack-compaction'
  if (native && !record.span) return false
  if ((!memory && !restart && !native) || record.end === undefined)
    return memory || restart

  const { api } = (backend ??=
    require('../server/lib/trace/otel-api') as typeof import('../server/lib/trace/otel-api'))
  const meter = api.metrics.getMeter('next.js', process.env.__NEXT_VERSION)
  const parent =
    record.context ?? record.parent?.context ?? defaultParent?.context
  const context = parent
    ? api.trace.setSpanContext(api.ROOT_CONTEXT, parent)
    : api.ROOT_CONTEXT
  const tags = attributes(record.encoded)
  const measurements: [string, string, string][] = native
    ? [
        ['bytes_written', 'turbopack.bytes_written', 'By'],
        ['bytes_deleted', 'turbopack.bytes_deleted', 'By'],
        ['task_count', 'turbopack.task_count', '{task}'],
      ]
    : [
        ['memory.rss', 'memory.rss', 'By'],
        ['memory.heapUsed', 'memory.heap_used', 'By'],
        ['memory.heapTotal', 'memory.heap_total', 'By'],
        ['memory.heapMax', 'memory.heap_limit', 'By'],
        ['memory.heapSizeLimit', 'memory.heap_limit', 'By'],
      ]
  // Paths and numeric trace IDs belong to traces, not metric dimensions.
  const dimensions = { operation: record.name }
  for (const [tag, suffix, unit] of measurements) {
    if (tags[tag] === undefined) continue
    const value = Number(tags[tag])
    if (!Number.isFinite(value) || value < 0) continue
    const name = `next.tooling.${suffix}`
    let histogram = histograms.get(name)
    if (!histogram) {
      histogram = meter.createHistogram(name, { unit })
      histograms.set(name, histogram)
    }
    if (!canEmit(record)) return memory || restart
    histogram.record(value, dimensions, context)
  }
  if (restart && canEmit(record)) {
    meter
      .createCounter('next.tooling.server.restarts', { unit: '{restart}' })
      .add(1, { reason: 'memory-threshold' }, context)
  }
  return memory || restart
}

function warnLoss() {
  if (!warned) {
    warned = true
    console.warn(
      'Next.js tooling OTel reporting limit reached or reporting failed; some external signals or attributes may be missing. Local trace files are unaffected.'
    )
  }
}

function attributes(encoded: string | undefined): Attributes {
  const result: Attributes = {}
  if (!encoded) return result
  const tags = JSON.parse(encoded) as Record<string, unknown>
  for (const [key, value] of Object.entries(tags)) {
    if (value === undefined || value === null) continue
    result[key] =
      typeof value === 'string' ||
      typeof value === 'number' ||
      typeof value === 'boolean'
        ? value
        : JSON.stringify(value)
  }
  return result
}

function time(ns: bigint): HrTime {
  return [
    Number(ns / BigInt(1_000_000_000)),
    Number(ns % BigInt(1_000_000_000)),
  ]
}

function release(record: ReportingRecord) {
  if (record.retained) {
    record.retained = false
    retainedBytes -= record.size
    records.delete(record)
    if (coordinatorRecords.get(record.id) === record)
      coordinatorRecords.delete(record.id)
  }
  record.name = ''
  record.encoded = undefined
  record.span = undefined
  record.parent = undefined
  record.size = 0
  // Only the small identity/context token survives through direct local handles.
}

function clearWork() {
  for (const record of records.values()) release(record)
}

function canEmit(record: ReportingRecord) {
  return (
    record.retained && record.generation === generation && state === 'ready'
  )
}

// Selected SDK work runs synchronously; unselected local producers never enter
// this adapter or pay its application sampling/processor costs.
function emit(record: ReportingRecord) {
  try {
    if (reportMeasurements(record)) {
      if (record.end !== undefined) release(record)
      return
    }
    const {
      api: { ROOT_CONTEXT, SpanStatusCode, trace },
      getTracerInstance,
    } = (backend ??=
      require('../server/lib/trace/otel-api') as typeof import('../server/lib/trace/otel-api'))
    const completed = record.end !== undefined
    const alreadyStarted = !!record.span
    if (!record.span) {
      const parent =
        record.parent?.context ??
        (record.parentId === undefined || record === defaultParent
          ? undefined
          : defaultParent?.context)
      const context = parent
        ? trace.setSpanContext(ROOT_CONTEXT, parent)
        : ROOT_CONTEXT
      const tracer = getTracerInstance()
      if (!canEmit(record)) return
      const span = tracer.startSpan(
        record.name,
        {
          startTime: time(record.start),
          attributes: {
            // Correlation precedes legacy tags to survive SDK attribute limits.
            'next.tooling.id': record.id,
            ...(record.parentId === undefined
              ? {}
              : { 'next.tooling.parent_id': record.parentId }),
            ...(completed ? attributes(record.encoded) : undefined),
          },
        },
        context
      )
      if (!canEmit(record)) return
      record.span = span
      record.context = span.spanContext()
    }
    if (record.end !== undefined && canEmit(record)) {
      // Completion can itself happen reentrantly during startSpan/onStart.
      if (alreadyStarted || !completed)
        record.span.setAttributes(attributes(record.encoded))
      if (!canEmit(record)) return
      if (!alreadyStarted) reportMeasurements(record)
      if (!canEmit(record)) return
      if (record.failed) record.span.setStatus({ code: SpanStatusCode.ERROR })
      if (!canEmit(record)) return
      record.span.end(time(record.end))
      release(record)
    }
  } catch {
    if (record.generation === generation) warnLoss()
    release(record)
  }
}

function report(input: Iterable<ReportingRecord>) {
  if (state !== 'ready' || suppressed) return
  if (reporting) {
    reentered = true
    return
  }
  reporting = true
  try {
    do {
      reentered = false
      // Synchronous iterative ancestry resolution also handles deep, completion-
      // ordered worker batches. No traversal or SDK-creation work survives a turn.
      const stack: ReportingRecord[] = []
      const visiting = new Set<ReportingRecord>()
      for (const next of input) {
        stack.push(next)
        visiting.add(next)
        while (stack.length) {
          const record = stack[stack.length - 1]
          if (canEmit(record) && (!record.span || record.end !== undefined)) {
            let parent = record.parent
            if (
              parent &&
              (parent.generation !== generation ||
                (!parent.retained && !parent.context))
            ) {
              parent = record.parent =
                record === defaultParent ? undefined : defaultParent
            }
            if (parent?.retained && !parent.context) {
              if (!visiting.has(parent)) {
                stack.push(parent)
                visiting.add(parent)
                continue
              }
              warnLoss()
              record.parent =
                record === defaultParent ? undefined : defaultParent
              if (
                record.parent &&
                !visiting.has(record.parent) &&
                !record.parent.context
              )
                continue
              record.parent = undefined
            }
            emit(record)
          }
          stack.pop()
          visiting.delete(record)
        }
      }
      input = records.values()
    } while (reentered)
  } finally {
    reporting = false
  }
}

function retain(
  id: number,
  parentId: number | undefined,
  name: string,
  start: bigint,
  parent?: ReportingRecord,
  root = false
): ReportingRecord | undefined {
  // A root marker cannot turn a compiler worker into an SDK coordinator.
  if (suppressed) return undefined
  if (root && (defaultParent || state === 'closed')) {
    generation++
    clearWork()
    defaultParent = undefined
    state = 'unregistered'
    warned = false
  }
  if (state === 'closed') return undefined
  const size = 256 + 2 * name.length
  const reserve = defaultParent?.retained || root ? 0 : 1
  if (
    records.size + reserve >= REPLAY_EVENT_LIMIT ||
    retainedBytes + size + reserve * ROOT_BYTES > REPLAY_BYTE_LIMIT ||
    (root && size > ROOT_BYTES)
  ) {
    warnLoss()
    return undefined
  }
  let reportingParent: ReportingRecord | undefined
  if (!root) {
    reportingParent = parent ?? coordinatorRecords.get(parentId!)
    if (reportingParent === undefined && parentId !== undefined) {
      reportingParent = defaultParent
    }
  }
  const record: ReportingRecord = {
    id,
    parentId,
    name,
    start,
    parent: reportingParent,
    retained: true,
    size,
    generation,
  }
  retainedBytes += size
  records.add(record)
  if (root) defaultParent = record
  return record
}

export function startReporting(
  ...args: Parameters<typeof retain>
): ReportingRecord | undefined {
  const record = retain(...args)
  if (record) {
    coordinatorRecords.set(record.id, record)
    report([record])
  }
  return record
}

function complete(
  record: ReportingRecord,
  end: bigint,
  tags: Record<string, unknown>
) {
  // Terminal metadata survives payload overflow/encoding failure.
  record.end = end
  record.failed = tags.failed === true
  try {
    const encoded = JSON.stringify(tags)
    if (!record.retained || record.generation !== generation) return
    const bytes = 2 * encoded.length
    const reserve = defaultParent?.retained ? 0 : ROOT_BYTES
    if (retainedBytes + bytes + reserve > REPLAY_BYTE_LIMIT) warnLoss()
    else {
      record.encoded = encoded
      record.size += bytes
      retainedBytes += bytes
    }
  } catch {
    if (record.generation === generation) warnLoss()
  }
}

export function endReporting(
  record: ReportingRecord | undefined,
  end: bigint,
  tags: Record<string, unknown>
) {
  if (
    !record?.retained ||
    record.generation !== generation ||
    record.end !== undefined
  )
    return
  complete(record, end, tags)
  report([record])
}

export function configureReporting(
  parentId: number | undefined,
  worker: boolean
) {
  defaultParent = coordinatorRecords.get(parentId!) ?? defaultParent
  suppressed = worker
  if (worker) clearWork()
}

export function replayCompleted(
  events: TraceEvent[],
  timing: (event: TraceEvent) => { start: bigint; end: bigint },
  parentId: (event: TraceEvent) => number | undefined = (event) =>
    event.parentId,
  parent?: ReportingRecord
) {
  if (suppressed || state === 'closed') return
  if (!defaultParent) {
    if (events.length) warnLoss()
    return
  }
  const batch = new Map<number, ReportingRecord>()
  const parents = new Map<number, number | undefined>()
  for (const event of events) {
    const { start, end } = timing(event)
    const record = retain(event.id, event.parentId, event.name, start)
    if (record) {
      complete(record, end, event.tags ?? {})
      batch.set(event.id, record)
      parents.set(event.id, parentId(event))
    }
  }
  // Completion order is not topology order. Stage the entire admitted batch
  // before inline reporting; a dropped parent falls back to the real root.
  for (const record of batch.values()) {
    record.parent =
      parent ??
      batch.get(parents.get(record.id)!) ??
      coordinatorRecords.get(parents.get(record.id)!) ??
      defaultParent
  }
  report(batch.values())
}

export function enableReporting() {
  if (state !== 'unregistered' || suppressed) return
  state = 'ready'
  report(records.values())
}

export function closeReporting(): void {
  state = 'closed'
  clearWork()
  defaultParent = undefined
}
