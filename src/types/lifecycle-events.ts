import { AVMTracesEventData, TealSourcesDebugEventData } from './debugging'
import type { RetryWaitLike } from './retry'

export enum EventType {
  TxnGroupSimulated = 'TxnGroupSimulated',
  AppCompiled = 'AppCompiled',
  /** A request of an algod or indexer client made by algokit-utils is about to wait before a retry (dt-algosdk only). */
  RetryWait = 'retry-wait',
}

export type EventDataMap = {
  [EventType.TxnGroupSimulated]: AVMTracesEventData
  [EventType.AppCompiled]: TealSourcesDebugEventData
  [EventType.RetryWait]: RetryWaitLike
  [key: string]: unknown
}
