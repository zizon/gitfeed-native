/**
 * Runtime types for the shared snapshot store.
 *
 * `@deepseek-ai/dsh-client-store` is seeded into the Harness browser module
 * table, so this bundle requires it at runtime instead of shipping it
 * (`build.mjs` marks it external). The package is not published to npm, so the
 * build cannot read its shipped declarations; this file mirrors the engine
 * surface the reader uses.
 */
declare module '@deepseek-ai/dsh-client-store' {
  /** Bare snapshot source with its two write operations; no React members. */
  export interface SnapshotStore<T> {
    getSnapshot(): T
    subscribe(fn: () => void): () => void
    /** Mutate through an immer draft. */
    update(mutator: (draft: T) => void): void
    /** Replace the snapshot wholesale. */
    set(next: T): void
  }

  export function createSnapshotStore<T>(
    init: T,
    opts?: { flush?: 'raf' | 'sync'; persist?: { name: string } },
  ): SnapshotStore<T>
}
