// PARALLEL-STUB: replaced at merge by TASK-401's full implementation.
// This minimal stub provides the trpc client shape needed by PendingApprovalCard
// to typecheck in isolation during parallel sprint execution.

/**
 * Minimal tRPC proxy stub that mirrors the cyboflow.approvals shape.
 * The real implementation uses createTRPCProxyClient with trpc-electron's
 * ipcLink (see frontend/src/utils/trpcClient.ts for the pattern).
 */

type MutationFn<TInput> = (input: TInput) => Promise<void>;

interface ApprovalsProxy {
  approve: { mutate: MutationFn<{ approvalId: string; message?: string }> };
  reject: { mutate: MutationFn<{ approvalId: string; message?: string }> };
}

interface CyboflowProxy {
  approvals: ApprovalsProxy;
}

interface TrpcProxy {
  cyboflow: CyboflowProxy;
}

function makeNotImplemented(name: string): MutationFn<unknown> {
  return () => Promise.reject(new Error(`[STUB] trpc.${name} not implemented — replace with real client at merge`));
}

export const trpc: TrpcProxy = {
  cyboflow: {
    approvals: {
      approve: { mutate: makeNotImplemented('cyboflow.approvals.approve') as MutationFn<{ approvalId: string; message?: string }> },
      reject:  { mutate: makeNotImplemented('cyboflow.approvals.reject')  as MutationFn<{ approvalId: string; message?: string }> },
    },
  },
};
