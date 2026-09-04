import { Test } from '@nestjs/testing';
import { describe, expect, it } from 'vitest';
import { AppModule } from '../src/app.module';
import { WorkerModule } from '../src/worker.module';

/**
 * The DI graph, actually compiled — one test per entrypoint.
 *
 * Every other spec builds services with `new Service(mockA, mockB)`, which
 * bypasses Nest's reflection entirely: no test in the suite could observe a
 * provider that fails to RESOLVE. So three `import type` erasures and a
 * missing LlmModule import in the worker graph shipped past 187 green tests,
 * lint, typecheck and build, and BOTH entrypoints failed to boot for three
 * phases while every signal we had reported clean.
 *
 * `import type` on a class used as an un-decorated constructor parameter
 * erases the binding `emitDecoratorMetadata` needs, so Nest sees a bare
 * `Function` and cannot resolve it. It is valid TypeScript — build and
 * typecheck are blind by construction. Only compiling the real graph catches
 * it. CLAUDE.md names this hazard by name; this file is what enforces it.
 *
 * `.compile()` resolves every provider without listening on a port or
 * starting the queue consumer, so it is a fast check, not an e2e run.
 */
describe('application bootstrap', () => {
  it('compiles the API module graph (src/main.ts)', async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    expect(moduleRef).toBeDefined();
    await moduleRef.close();
  });

  it('compiles the worker module graph (src/worker.ts)', async () => {
    const moduleRef = await Test.createTestingModule({ imports: [WorkerModule] }).compile();
    expect(moduleRef).toBeDefined();
    await moduleRef.close();
  });
});
