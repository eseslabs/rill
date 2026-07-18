import { useCallback, useEffect, useRef, useState } from "react";

/** Shown whenever a request is aborted by the composed `AbortSignal.timeout`
 *  in rill-api.ts (not by the hook's own cleanup/unmount abort) — distinct
 *  from a generic failure so the user knows a retry is worthwhile instead of
 *  assuming the request is fundamentally broken. */
export const FLOW_REQUEST_TIMEOUT_MESSAGE = "Rill API didn't respond in time — try again";

function isDomException(err: unknown, name: string): boolean {
  return err instanceof DOMException && err.name === name;
}

function describeFlowRequestError(err: unknown): string {
  if (isDomException(err, "TimeoutError")) return FLOW_REQUEST_TIMEOUT_MESSAGE;
  if (err instanceof Error) return err.message;
  return "Request failed";
}

export type UseFlowRequestResult<T> = {
  data: T | null;
  error: string | null;
  loading: boolean;
  /** Fires the request (aborting any still-in-flight call from a previous
   *  `run()`). Always uses the latest `requestFn` closure, so it's safe to
   *  call from an effect or a click handler without re-memoizing. */
  run: () => void;
  /** Aborts any in-flight request without starting a new one. */
  abort: () => void;
  /** Aborts any in-flight request and clears data/error/loading back to
   *  initial. The flow dialogs are mounted persistently (Radix controls their
   *  visibility), so callers use this to clear a stale result/error from a
   *  previous open instead of relying on a remount that no longer happens. */
  reset: () => void;
};

/**
 * Unifies the fetch-on-demand pattern every flow dialog (export/simulate/
 * discover) repeats: one AbortController per call, superseding any prior
 * in-flight request and aborted on unmount, with timeouts (AbortSignal.timeout
 * composed in rill-api.ts) surfaced as a distinct, retry-worthy message
 * instead of a generic failure (R18).
 */
export function useFlowRequest<T>(requestFn: (signal: AbortSignal) => Promise<T>): UseFlowRequestResult<T> {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  // "Latest ref" pattern: updated unconditionally every render so `run` (a
  // stable useCallback) always invokes whatever closure the caller most
  // recently rendered with, without needing `requestFn` in a dependency array.
  const requestFnRef = useRef(requestFn);
  requestFnRef.current = requestFn;

  const controllerRef = useRef<AbortController | null>(null);

  const abort = useCallback(() => {
    controllerRef.current?.abort();
  }, []);

  const run = useCallback(() => {
    controllerRef.current?.abort(); // supersede any in-flight call from a previous run()
    const controller = new AbortController();
    controllerRef.current = controller;
    setLoading(true);
    setError(null);
    setData(null);

    requestFnRef
      .current(controller.signal)
      .then((result) => {
        if (controllerRef.current !== controller) return; // superseded — ignore stale response
        setData(result);
      })
      .catch((err: unknown) => {
        if (controllerRef.current !== controller) return; // superseded — ignore stale response
        if (isDomException(err, "AbortError")) return; // our own deliberate abort — not a user-visible error
        setError(describeFlowRequestError(err));
      })
      .finally(() => {
        if (controllerRef.current === controller) setLoading(false);
      });
  }, []);

  const reset = useCallback(() => {
    controllerRef.current?.abort();
    controllerRef.current = null;
    setData(null);
    setError(null);
    setLoading(false);
  }, []);

  // Mount-once cleanup: abort whatever's in flight when the component
  // unmounts (R18 — abort on unmount).
  useEffect(() => {
    return () => {
      controllerRef.current?.abort();
    };
  }, []);

  return { data, error, loading, run, abort, reset };
}
