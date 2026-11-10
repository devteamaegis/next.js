# Experimental OpenTelemetry tooling prototype

Opt-in reporting of dev and build tooling through the application's OpenTelemetry SDK. This prototype's API and coverage are provisional.

## Setup

Initialize your provider and exporter in `instrumentation.ts`, then enable tooling reporting in `next.config.ts`:

```ts
import type { NextConfig } from 'next'

export default {
  experimental: { devAndBuildOtel: true },
} satisfies NextConfig
```

The option defaults to `false`. Dev uses its existing instrumentation lifecycle. Opted-in builds also await `register()` in the build coordinator after compilation, using the current build's compiled instrumentation. Use `process.env.NEXT_PHASE` with `PHASE_PRODUCTION_BUILD` or `PHASE_DEVELOPMENT_SERVER` from `next/constants` to choose phase-specific exporters.

Await SDK initialization in `register()`. The application owns export configuration, sampling and delivery. Next does not flush or shut down the SDK; queued telemetry may be lost at process exit. Existing production request tracing is unchanged.

## Coverage

Selected spans cover build/compiler phases, static checks and generation, dev startup, compilation, HMR, rendering and browser hydration. Per-module profiling, loader/plugin work and per-page static checks/renders remain local-only. See `ToolingSpan` in `server/lib/trace/constants.ts` and `additionalSignals` in `otel.ts` for the selection.

Memory samples become histograms; memory-threshold restarts also increment a counter. Turbopack persistence/compaction report spans and measurements. Metrics use finite operation/reason dimensions and remain independent of trace sampling.

Each dev-server child has a `dev-server-session` root that ends on normal shutdown or restart. Builds use `next-build`. Session metadata and `next.tooling.id` / `next.tooling.parent_id` correlate SDK spans with local traces.

Local trace files and Request Insights remain independent of the opt-in and application sampling. The legacy upload flag still uses its existing format.

## Capture and replay

`local-span-recorder.ts` owns local capture and completion. Selected operations additionally use the existing Next tracer backend and application provider, preserving explicit tooling ancestry rather than adopting active request context. Compiler workers return completed records for coordinator replay without initializing another SDK.

Early records replay after registration with original timestamps. Later SDK calls run synchronously, so application processors can block tooling work. Retention is bounded by 10,000 descriptors and 8 MiB of accounted metadata; overflow warns and drops external reporting without dropping local traces. Closing releases pending records without fabricating completion times for unfinished work.

## Tests

`test/e2e/app-dir/otel-tooling` covers configuration, sampling, HMR, worker replay, restarts and build failures. Its synchronous exporter verifies SDK delivery, not network delivery or batched-exporter draining. `test/unit/otel-tooling-replay.test.ts` covers replay limits, SDK callback failures/reentrancy and closing.
