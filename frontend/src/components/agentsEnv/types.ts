/**
 * Backend shapes the Agents & Environments surfaces consume, inferred from the AppRouter. This is the ONLY
 * place renderer code names them, so a contract change fails `tsc -b` here instead of dropping fields at
 * runtime (docs/CODE-PATTERNS.md "IPC / type-parity rules").
 */
import type { inferRouterInputs, inferRouterOutputs } from '@trpc/server';
import type { AppRouter } from '../../../../shared/types/trpc';

type RO = inferRouterOutputs<AppRouter>['cyboflow'];
type RI = inferRouterInputs<AppRouter>['cyboflow'];
type Yield<T> = T extends AsyncIterable<infer U> ? U : never;

export type AgentsFeatureStatus = RO['persistentAgents']['status'];
export type ConnectorViewT = RO['persistentAgents']['listConnectors'][number];
export type AgentViewT = RO['persistentAgents']['listAgents'][number];
export type ConnectionViewT = NonNullable<AgentViewT['connection']>;
export type ThreadPageT = RO['persistentAgents']['getThread'];
export type ThreadMessage = ThreadPageT['messages'][number];
export type ConnectInputT = RI['persistentAgents']['connect'];
export type ConnectionInputT = ConnectInputT['connection'];
export type RetiredConnectionViewT = AgentViewT['retiredConnections'][number];
export type SwitchResult = RO['persistentAgents']['switchConnection'];
export type OkResultT = RO['persistentAgents']['archiveAgent'];
export type ConnectResult = RO['persistentAgents']['connect'];
export type PairingPayloadT = NonNullable<Extract<ConnectResult, { ok: true }>['pairing']>;
export type RepairPairingResult = RO['persistentAgents']['repairPairing'];
export type VerifyResult = RO['persistentAgents']['verify'];
export type SendResult = RO['persistentAgents']['send'];
export type DisconnectResult = RO['persistentAgents']['disconnect'];
export type ControlResult = RO['persistentAgents']['control'];
export type CredentialViewT = RO['persistentAgents']['listCredentials'][number];
export type CredentialMutationResult = RO['persistentAgents']['rotateCredential'];
export type ForgetCredentialResult = RO['persistentAgents']['forgetCredential'];
export type AgentsChangedEvent = Yield<RO['persistentAgents']['onAgentsChanged']>;
export type ThreadEvent = Yield<RO['persistentAgents']['onThreadEvent']>;
export type CloudStatusT = RO['cloud']['status'];
export type CloudChangedEventT = Yield<RO['cloud']['onCloudChanged']>;
/** The failure arm every persistentAgents mutation can return (= PersistentAgentsFailure). */
export type Failure = Extract<SendResult, { ok: false }>;
