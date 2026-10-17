// Keep runtime events newer than in-flight health probes. Multiple UI triggers
// share a request, and unmounted screens never receive late updates.
export function createLocalStatusMonitor<T>(read: () => Promise<T>, publish: (status: T | null) => void) {
  let revision = 0;
  let disposed = false;
  let pending: Promise<T | null> | null = null;
  return {
    accept(status: T) {
      if (disposed) return;
      revision += 1;
      publish(status);
    },
    refresh(): Promise<T | null> {
      if (disposed) return Promise.resolve(null);
      if (pending) return pending;
      const requestRevision = ++revision;
      pending = read().then((status) => {
        if (disposed || requestRevision !== revision) return null;
        publish(status);
        return status;
      }).catch(() => {
        if (!disposed && requestRevision === revision) publish(null);
        return null;
      }).finally(() => { pending = null; });
      return pending;
    },
    dispose() { disposed = true; revision += 1; },
  };
}
